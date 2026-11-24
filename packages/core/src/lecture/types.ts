import type { BBox, Item } from '../types';

/**
 * Lecture mode (docs/lecture-mode.md). A session is one audio timeline with every local ink event on it, the region
 * crops an agent would have received, and a timed transcript. All times are ms on the session's timeline, which only
 * runs while recording.
 */

/** A session's state. */
export type LectureState = 'recording' | 'paused' | 'stopped';
export type Transcriber = 'device' | 'cloud' | 'none';

/** One timeline event (one JSONL line). Items carry full points, erased ones included. */
export type LectureEvent =
  | { t: number; k: 'start'; at: number }
  | { t: number; k: 'page'; p: string; n: number }
  | { t: number; k: 'base'; p: string; ids: string[] }
  | { t: number; k: 'add'; p: string; items: Item[]; by?: 'undo' | 'redo' }
  | { t: number; k: 'erase'; p: string; items: Item[]; by?: 'undo' | 'redo' }
  | { t: number; k: 'update'; p: string; items: Item[]; before?: Item[]; by?: 'undo' | 'redo' }
  | { t: number; k: 'pause' }
  | { t: number; k: 'resume' }
  | { t: number; k: 'stop' };

export type LectureEventKind = LectureEvent['k'];

/** A finished audio chunk: a standalone file (an R2 asset), `t0`..`t0 + dur` on the timeline. */
export interface AudioChunk { sha: string; mime: string; t0: number; dur: number; bytes: number }

export interface TranscriptWord { w: string; t0: number; t1: number }
/** A transcript line on the timeline. */
export interface TranscriptSegment { t0: number; t1: number; text: string; words?: TranscriptWord[]; src?: 'device' | 'cloud' }

/** A crop's region: its R label, page position, box on the 0–1000 grid `[x, y, w, h]`, strokes added and erased. */
export interface CropRegion { label: string; row?: number; page: number; box: [number, number, number, number]; add: number; erase: number }
/** One crop: the Q-ink update text and its PNG (an R2 asset), at `t` (the last ink event before the pause). */
export interface LectureCrop { t: number; sha: string; w: number; h: number; text: string; regions: CropRegion[] }

/** The session doc's `meta`. */
export interface LectureMeta {
  id: string;
  notebookId: string;
  /** Wall clock at t = 0 (ms since epoch). */
  startedAt: number;
  /** Recorded length so far (ms). */
  durationMs: number;
  state: LectureState;
  /** Time of the newest event flushed to the timeline (the server stamps crops with it). */
  lastT: number;
  transcriber: Transcriber;
  title?: string;
}

/** What the library lists per session (`lib:{userId}` `lectures`). */
export interface LectureSummary { id: string; notebookId: string; startedAt: number; durationMs: number; state: LectureState; title?: string }

/** A page box in page units, for crops (re-exported for convenience). */
export type { BBox };
