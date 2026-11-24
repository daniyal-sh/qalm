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

function eventFromJson(o: Record<string, unknown>): LectureEvent | null {
  if (typeof o.t !== 'number' || typeof o.k !== 'string') return null;
  const e = { ...o } as Record<string, unknown>;
  if (Array.isArray(o.items)) e.items = (o.items as Record<string, unknown>[]).map(itemFromJson);
  if (Array.isArray(o.before)) e.before = (o.before as Record<string, unknown>[]).map(itemFromJson);
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
      const e = eventFromJson(JSON.parse(s) as Record<string, unknown>);
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

/** Parses `mm:ss`, `h:mm:ss` or plain seconds into ms; null if it isn't a time. */
export function parseT(s: string): number | null {
  const m = /^(?:(\d+):)?(\d+):(\d{1,2})$/.exec(s.trim());
  if (m) return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
  return /^\d+$/.test(s.trim()) ? Number(s) * 1000 : null;
}
