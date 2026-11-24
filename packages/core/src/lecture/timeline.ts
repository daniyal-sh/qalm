import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import type { InkPoint, Item } from '../types';
import type { LectureEvent } from './types';

/**
 * The timeline as JSONL: one event per line. Stroke points are arrays `[x, y, p, tilt, az, t]` (x, y rounded to 0.01;
 * p, tilt, az to 0.001; t whole ms), so the text is compact and readable without qalm's code (LECTURE.md).
 */

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

type JsonPoint = [number, number, number, number, number, number];

/** An item as it goes into the timeline: points as arrays. */
export function itemToJson(it: Item): Record<string, unknown> {
  if (it.type !== 'stroke') return { ...it };
  return { ...it, points: it.points.map((q): JsonPoint => [r2(q.x), r2(q.y), r3(q.p), r3(q.tilt), r3(q.az), Math.round(q.t)]) };
}

/** The reverse of `itemToJson` (also accepts points already as objects). */
export function itemFromJson(o: Record<string, unknown>): Item {
  if (o.type !== 'stroke' || !Array.isArray(o.points)) return o as unknown as Item;
  const points: InkPoint[] = (o.points as unknown[]).map((q) =>
    Array.isArray(q) ? { x: Number(q[0]), y: Number(q[1]), p: Number(q[2] ?? 0.5), tilt: Number(q[3] ?? Math.PI / 2), az: Number(q[4] ?? 0), t: Number(q[5] ?? 0) } : (q as InkPoint),
  );
  return { ...(o as object), points } as unknown as Item;
}

function eventToJson(e: LectureEvent): Record<string, unknown> {
  const o: Record<string, unknown> = { ...e };
  if ('items' in e) o.items = e.items.map(itemToJson);
  if ('before' in e && e.before) o.before = e.before.map(itemToJson);
  return o;
}

const isItem = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string' && typeof (v as { type?: unknown }).type === 'string';

/** One event, checked: a known kind with the fields it needs (imports and other clients' chunks can be anything). */
function eventFromJson(o: unknown): LectureEvent | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.t !== 'number' || !Number.isFinite(r.t) || r.t < 0 || typeof r.k !== 'string') return null;
  const e = { ...r } as Record<string, unknown>;
  switch (r.k) {
    case 'start':
      if (typeof r.at !== 'number') return null;
      break;
    case 'page':
      if (typeof r.p !== 'string' || typeof r.n !== 'number') return null;
      break;
    case 'base':
      if (typeof r.p !== 'string' || !Array.isArray(r.ids)) return null;
      e.ids = r.ids.filter((x) => typeof x === 'string');
      break;
    case 'add':
    case 'erase':
    case 'update':
      if (typeof r.p !== 'string' || !Array.isArray(r.items)) return null;
      e.items = r.items.filter(isItem).map(itemFromJson);
      if (Array.isArray(r.before)) e.before = r.before.filter(isItem).map(itemFromJson);
      else delete e.before;
      break;
    case 'pause':
    case 'resume':
    case 'stop':
      break;
    default:
      return null;
  }
  return e as unknown as LectureEvent;
}

/** Events as JSONL text (each line ends with `\n`). */
export function eventsToJsonl(events: readonly LectureEvent[]): string {
  return events.map((e) => `${JSON.stringify(eventToJson(e))}\n`).join('');
}

/** Parses JSONL; blank and malformed lines are skipped. */
export function eventsFromJsonl(text: string): LectureEvent[] {
  const out: LectureEvent[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = eventFromJson(JSON.parse(s) as unknown);
      if (e) out.push(e);
    } catch {
      /* a torn line: skip */
    }
  }
  return out;
}

/** A timeline chunk as stored in the session doc: deflated JSONL. */
export function packTimelineChunk(events: readonly LectureEvent[]): Uint8Array {
  return deflateSync(strToU8(eventsToJsonl(events)), { level: 6 });
}

export function unpackTimelineChunk(chunk: Uint8Array): LectureEvent[] {
  try {
    return eventsFromJsonl(strFromU8(inflateSync(chunk)));
  } catch {
    return [];
  }
}

/** All chunks' events in time order (stable: events with equal t keep their chunk order). */
export function unpackTimeline(chunks: readonly Uint8Array[]): LectureEvent[] {
  const all = chunks.flatMap(unpackTimelineChunk);
  return all.map((e, i) => [e, i] as const).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([e]) => e);
}

/** `mm:ss` (or `h:mm:ss`) for a timeline time. */
export function fmtT(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `fmtT` with the milliseconds when there are any (`03:12.345`): an exact point, for `more:` pointers. */
export function fmtTExact(ms: number): string {
  const r = Math.max(0, Math.round(ms));
  return r % 1000 ? `${fmtT(r)}.${String(r % 1000).padStart(3, '0')}` : fmtT(r);
}

/** Parses `mm:ss`, `h:mm:ss` or plain seconds (each with optional `.mmm`) into ms; null if it isn't a time. */
export function parseT(s: string): number | null {
  const m = /^(?:(\d+):)?(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s.trim());
  const frac = (f: string | undefined) => (f ? Number(f.padEnd(3, '0')) : 0);
  if (m) return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac(m[4]);
  const p = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s.trim());
  return p ? Number(p[1]) * 1000 + frac(p[2]) : null;
}
