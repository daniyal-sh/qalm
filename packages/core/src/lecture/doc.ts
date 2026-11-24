import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { packTimelineChunk, unpackTimeline } from './timeline';
import type { AudioChunk, LectureCrop, LectureEvent, LectureMeta, LectureSummary, TranscriptSegment } from './types';

/** Doc id of a session: `lec:{notebookId}:{sessionId}` (docs/lecture-mode.md §5). */
export const lectureDocId = (notebookId: string, sessionId: string) => `lec:${notebookId}:${sessionId}`;

/** Server-written transactions (crops) use this origin. */
export const LECTURE_SERVER_ORIGIN = Symbol('qalm-lecture-server');

/**
 * Wraps a session doc: `meta`, the append-only `timeline` (deflated JSONL chunks), `audio` chunks, `transcript`
 * segments and `crops`. Lecture data lives only here, never in page or index docs.
 */
export class LectureDoc {
  readonly doc: Y.Doc;
  private readonly metaMap: Y.Map<unknown>;
  private readonly timelineArr: Y.Array<Uint8Array>;
  private readonly audioArr: Y.Array<AudioChunk>;
  private readonly transcriptArr: Y.Array<TranscriptSegment>;
  private readonly cropArr: Y.Array<LectureCrop>;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.metaMap = doc.getMap('meta');
    this.timelineArr = doc.getArray('timeline');
    this.audioArr = doc.getArray('audio');
    this.transcriptArr = doc.getArray('transcript');
    this.cropArr = doc.getArray('crops');
  }

  meta(): LectureMeta {
    const o = Object.fromEntries(this.metaMap.entries()) as Partial<LectureMeta>;
    return {
      id: o.id ?? '',
      notebookId: o.notebookId ?? '',
      startedAt: Number(o.startedAt) || 0,
      durationMs: Number(o.durationMs) || 0,
      state: o.state === 'recording' || o.state === 'paused' ? o.state : 'stopped',
      lastT: Number(o.lastT) || 0,
      transcriber: o.transcriber === 'device' || o.transcriber === 'cloud' ? o.transcriber : 'none',
      ...(typeof o.title === 'string' ? { title: o.title } : {}),
    };
  }

  setMeta(patch: Partial<LectureMeta>, origin: unknown = LOCAL_ORIGIN): void {
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && this.metaMap.get(k) !== v) this.metaMap.set(k, v);
    }, origin);
  }

  summary(): LectureSummary {
    const m = this.meta();
    return { id: m.id, notebookId: m.notebookId, startedAt: m.startedAt, durationMs: m.durationMs, state: m.state, ...(m.title ? { title: m.title } : {}) };
  }

  /** Appends events as one chunk and moves `lastT` (and `durationMs`) forward. */
  appendEvents(events: readonly LectureEvent[]): void {
    if (!events.length) return;
    const lastT = Math.max(this.meta().lastT, ...events.map((e) => e.t));
    this.doc.transact(() => {
      this.timelineArr.push([packTimelineChunk(events)]);
      this.metaMap.set('lastT', lastT);
      if ((Number(this.metaMap.get('durationMs')) || 0) < lastT) this.metaMap.set('durationMs', lastT);
    }, LOCAL_ORIGIN);
  }

  /** Every event, in time order. */
  events(): LectureEvent[] {
    return unpackTimeline(this.timelineArr.toArray());
  }

  timelineChunks(): Uint8Array[] {
    return this.timelineArr.toArray();
  }

  addAudio(chunk: AudioChunk): void {
    this.doc.transact(() => this.audioArr.push([chunk]), LOCAL_ORIGIN);
  }

  audio(): AudioChunk[] {
    return [...this.audioArr.toArray()].sort((a, b) => a.t0 - b.t0);
  }

  addTranscript(segments: readonly TranscriptSegment[]): void {
    if (segments.length) this.doc.transact(() => this.transcriptArr.push([...segments]), LOCAL_ORIGIN);
  }

  /** Segments in time order. */
  transcript(): TranscriptSegment[] {
    return [...this.transcriptArr.toArray()].sort((a, b) => a.t0 - b.t0);
  }

  /** Number of transcript segments (in arrival order: what an agent has been sent is a count). */
  transcriptCount(): number {
    return this.transcriptArr.length;
  }

  /** Segments in arrival order from index `from` (live MCP lines). */
  transcriptFrom(from: number): TranscriptSegment[] {
    return this.transcriptArr.slice(from);
  }

  addCrop(crop: LectureCrop, origin: unknown = LECTURE_SERVER_ORIGIN): void {
    this.doc.transact(() => this.cropArr.push([crop]), origin);
  }

  crops(): LectureCrop[] {
    return [...this.cropArr.toArray()].sort((a, b) => a.t - b.t);
  }

  /** Every asset the session holds (audio and crop PNGs), by sha256. */
  assetShas(): string[] {
    return [...new Set([...this.audioArr.toArray().map((a) => a.sha), ...this.cropArr.toArray().map((c) => c.sha)])];
  }

  observe(cb: () => void): () => void {
    const h = () => cb();
    this.doc.on('update', h);
    return () => this.doc.off('update', h);
  }
}
