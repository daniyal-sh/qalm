import type { CropRegion, LectureCrop, TranscriptSegment, TranscriptWord } from './types';

/**
 * Shape checks for lecture data that comes from outside this code: an imported `.qalm`, or a session doc another
 * client wrote. Anything malformed is dropped (never thrown), so a corrupt file can't break replay or MCP reads.
 */

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanWord(v: unknown): TranscriptWord | null {
  if (!obj(v) || typeof v.w !== 'string' || !num(v.t0) || !num(v.t1)) return null;
  return { w: v.w, t0: v.t0, t1: v.t1 };
}

/** A transcript segment, or null when it isn't one (non-numeric times, text not a string). */
export function cleanSegment(v: unknown): TranscriptSegment | null {
  if (!obj(v) || !num(v.t0) || typeof v.text !== 'string') return null;
  const t1 = num(v.t1) ? v.t1 : v.t0;
  const words = Array.isArray(v.words) ? v.words.map(cleanWord).filter((w): w is TranscriptWord => !!w) : null;
  const src = v.src === 'device' || v.src === 'cloud' ? v.src : null;
  return { t0: v.t0, t1, text: v.text, ...(words?.length ? { words } : {}), ...(src ? { src } : {}) };
}

export function cleanTranscript(v: unknown): TranscriptSegment[] {
  return Array.isArray(v) ? v.map(cleanSegment).filter((s): s is TranscriptSegment => !!s) : [];
}

function cleanRegion(v: unknown): CropRegion | null {
  if (!obj(v) || typeof v.label !== 'string' || !num(v.page)) return null;
  if (!Array.isArray(v.box) || v.box.length !== 4 || !v.box.every(num)) return null;
  const box = v.box as [number, number, number, number];
  return { label: v.label, ...(num(v.row) ? { row: v.row } : {}), page: v.page, box, add: num(v.add) ? v.add : 0, erase: num(v.erase) ? v.erase : 0 };
}

/** A crop, or null. `sha` may be empty (an import before its PNG is stored). */
export function cleanCrop(v: unknown): LectureCrop | null {
  if (!obj(v) || !num(v.t)) return null;
  return {
    t: v.t,
    sha: typeof v.sha === 'string' ? v.sha : '',
    w: num(v.w) ? v.w : 0,
    h: num(v.h) ? v.h : 0,
    text: typeof v.text === 'string' ? v.text : '',
    regions: Array.isArray(v.regions) ? v.regions.map(cleanRegion).filter((r): r is CropRegion => !!r) : [],
  };
}
