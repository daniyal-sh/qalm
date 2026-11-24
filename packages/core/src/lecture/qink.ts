import { fmtT, parseT } from './timeline';
import type { LectureCrop, LectureMeta, TranscriptSegment } from './types';

/** Lecture labels (`L1`, `L2`, …), notebook-wide and never reused. Stored by the server's notebook room. */
export interface QinkLectures { next: number; byId: Record<string, string> }

export const emptyLectures = (): QinkLectures => ({ next: 1, byId: {} });

export function lectureLabel(l: QinkLectures, sessionId: string): string {
  const hit = l.byId[sessionId];
  if (hit) return hit;
  const label = `L${l.next++}`;
  l.byId[sessionId] = label;
  return label;
}

/** `L2` → session id, or null. */
export function resolveLecture(l: QinkLectures, label: string): string | null {
  const want = label.trim().toUpperCase();
  return Object.entries(l.byId).find(([, v]) => v === want)?.[0] ?? null;
}

const MAX_LINE = 1000;
const quote = (s: string) => JSON.stringify(s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s);

/** A live transcript line in a `wait` update: `L2 03:12 "so the derivative"` (docs/lecture-mode.md §7). */
export function transcriptLine(label: string, s: TranscriptSegment): string {
  return `${label} ${fmtT(s.t0)} ${quote(s.text.trim())}`;
}

/** `L2 2026-11-24 47:10 stopped` (outline and session lists). */
export function lectureLine(label: string, m: LectureMeta): string {
  const day = m.startedAt ? new Date(m.startedAt).toISOString().slice(0, 10) : '';
  return `${label} ${day} ${fmtT(m.durationMs)} ${m.state}${m.title ? ` ${quote(m.title)}` : ''}`;
}

/** A `read("L2")` window: this much timeline, at most this many images. */
export const LECTURE_READ_WINDOW_MS = 10 * 60_000;
export const LECTURE_READ_IMAGES = 8;

/** Parses `L2` or `L2@10:00` (and `L2@600`); null if it isn't a lecture ref. */
export function parseLectureRef(ref: string): { label: string; from: number } | null {
  const m = /^(L\d+)(?:@(.+))?$/i.exec(ref.trim().replace(/\s+/g, ''));
  if (!m) return null;
  const from = m[2] ? parseT(m[2]) : 0;
  if (from === null) throw new Error(`Bad time in ${ref} (expected e.g. L2@10:00)`);
  return { label: m[1]!.toUpperCase(), from };
}

/** One part of a lecture read: a text line, or a crop's image (by asset sha) right after its line. */
export type LectureReadPart = { text: string } | { image: string };

/**
 * `read("L2")`: the transcript and crops interleaved by time from `from`, for one window. Crop lines are its regions
 * (`03:15 R40 p2 @120,300 260x80 +5`); the first `LECTURE_READ_IMAGES` crops come with their image.
 */
export function encodeLectureRead(label: string, meta: LectureMeta, transcript: readonly TranscriptSegment[], crops: readonly LectureCrop[], from = 0): LectureReadPart[] {
  const to = from + LECTURE_READ_WINDOW_MS;
  type Row = { t: number; seg?: TranscriptSegment; crop?: LectureCrop };
  const rows: Row[] = [
    ...transcript.filter((s) => s.t0 >= from && s.t0 < to).map((seg): Row => ({ t: seg.t0, seg })),
    ...crops.filter((c) => c.t >= from && c.t < to).map((crop): Row => ({ t: crop.t, crop })),
  ].sort((a, b) => a.t - b.t || (a.seg ? -1 : 1));
  const parts: LectureReadPart[] = [];
  const lines: string[] = [`#q ${label} ${fmtT(from)}-${fmtT(Math.min(to, Math.max(meta.durationMs, from)))} of ${fmtT(meta.durationMs)} ${meta.state}`];
  let images = 0;
  const flush = () => {
    if (lines.length) parts.push({ text: lines.join('\n') });
    lines.length = 0;
  };
  let cut: number | null = null;
  for (const r of rows) {
    if (r.seg) {
      lines.push(`${fmtT(r.t)} ${quote(r.seg.text.trim())}`);
      continue;
    }
    const c = r.crop!;
    if (images >= LECTURE_READ_IMAGES) {
      cut = r.t;
      break;
    }
    images++;
    const regionLines = c.regions.length
      ? c.regions.map((g) => `${fmtT(c.t)} ${g.label}${g.row ? ` [${g.row}]` : ''} p${g.page} @${g.box[0]},${g.box[1]} ${g.box[2]}x${g.box[3]}${g.add ? ` +${g.add}` : ''}${g.erase ? ` -${g.erase}` : ''}`)
      : [`${fmtT(c.t)} crop`];
    lines.push(...regionLines);
    flush();
    parts.push({ image: c.sha });
  }
  if (!rows.length) lines.push('(nothing in this part)');
  const next = cut ?? (to < meta.durationMs ? to : null);
  if (next !== null) lines.push(`more: read("${label}@${fmtT(next)}")`);
  flush();
  return parts;
}

const REGION_LINE = /^(R\d+)(?: \[(\d+)\])? p(\d+) @(-?\d+),(-?\d+) (\d+)x(\d+)(?: \+(\d+))?(?: -(\d+))?/;

/** The regions of a Q-ink update text (its `R…` lines), for a crop's JSON. */
export function parseCropRegions(text: string): import('./types').CropRegion[] {
  const out: import('./types').CropRegion[] = [];
  for (const line of text.split('\n')) {
    const m = REGION_LINE.exec(line.trim());
    if (!m) continue;
    out.push({
      label: m[1]!,
      ...(m[2] ? { row: Number(m[2]) } : {}),
      page: Number(m[3]),
      box: [Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])],
      add: Number(m[8] ?? 0),
      erase: Number(m[9] ?? 0),
    });
  }
  return out;
}
