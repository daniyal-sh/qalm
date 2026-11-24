/**
 * Playing a finished session back (docs/lecture-mode.md §6): audio chunk by chunk, the ink replayed at the current
 * time, the transcript, tap-a-stroke-to-seek. Platform-free: the doc, base ink, asset uris and player are injected.
 */
import { LectureDoc, LectureReplay, lectureDocId, strokeTimes, hitTestPoint, type AudioChunk, type Item, type LectureMeta, type TranscriptSegment } from '@qalm/core';
import type * as Y from 'yjs';

import type { ChunkPlayer } from './player.types';

export interface PlaybackDeps {
  openDoc(docId: string): Promise<{ doc: Y.Doc; release(): void }>;
  /** The page's items now (base ink comes from here when the timeline has no copy of it). */
  pageItems(pageId: string): Promise<Item[]>;
  /** A playable uri for a chunk, downloading it if needed; null when it can't be had (offline). */
  audioUri(chunk: AudioChunk): Promise<string | null>;
  player(): ChunkPlayer;
  now?: () => number;
}

export const SPEEDS = [1, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export class LecturePlayback {
  meta: LectureMeta | null = null;
  transcript: TranscriptSegment[] = [];
  chunks: AudioChunk[] = [];
  replay: LectureReplay | null = null;
  duration = 0;
  t = 0;
  playing = false;
  rate: Speed = 1;
  private times = new Map<string, number>();
  private player: ChunkPlayer | null = null;
  /** The chunk wanted at the current time (loading, loaded, or missing: silence). */
  private want: AudioChunk | null = null;
  /** The chunk actually in the player, ready: its position drives `t`. Null while one loads (the clock runs). */
  private inPlayer: AudioChunk | null = null;
  /** After a seek, the player's position is ignored until it reaches the target (it may still report the old one). */
  private pendingSeek: number | null = null;
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private listeners = new Set<() => void>();
  private handle: { release(): void } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PlaybackDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  async load(notebookId: string, sessionId: string): Promise<void> {
    const h = await this.deps.openDoc(lectureDocId(notebookId, sessionId));
    this.handle = h;
    const lec = new LectureDoc(h.doc);
    const events = lec.events();
    const pages = [...new Set(events.flatMap((e) => (e.k === 'base' ? [e.p] : [])))];
    const base = new Map<string, Map<string, Item>>();
    for (const p of pages) base.set(p, new Map((await this.deps.pageItems(p)).map((it) => [it.id, it])));
    this.replay = new LectureReplay(events, (p, id) => base.get(p)?.get(id));
    this.times = strokeTimes(events);
    this.meta = lec.meta();
    this.transcript = lec.transcript();
    this.chunks = lec.audio();
    this.duration = Math.max(this.meta.durationMs, this.replay.duration, ...this.chunks.map((c) => c.t0 + c.dur));
    this.t = 0;
    this.player = this.deps.player();
    this.emit();
  }

  /** Each page's items at the current time (only pages the session touched). */
  items(): Map<string, Item[]> {
    return this.replay?.at(this.t) ?? new Map();
  }

  /** The page shown at the current time. */
  pageNow(): string | null {
    return this.replay?.pageAt(this.t) ?? null;
  }

  /** The transcript line playing now (index), or -1. */
  lineNow(): number {
    let i = -1;
    for (let k = 0; k < this.transcript.length; k++) if (this.transcript[k]!.t0 <= this.t) i = k;
    return i;
  }

  private chunkAt(t: number): AudioChunk | null {
    return this.chunks.find((c) => t >= c.t0 && t < c.t0 + c.dur) ?? null;
  }

  /** Puts the chunk for time `t` in the player (or seeks within it). A chunk that can't be had plays as silence. */
  private async ensure(t: number): Promise<void> {
    const c = this.chunkAt(t);
    if (c && c === this.inPlayer) {
      this.player?.seek((t - c.t0) / 1000);
      this.pendingSeek = t;
      return;
    }
    if (c === this.want) return; // already loading it (or it is missing)
    this.player?.pause();
    this.want = c;
    this.inPlayer = null;
    this.pendingSeek = null;
    if (!c || !this.player) return;
    const uri = await this.deps.audioUri(c);
    if (this.want !== c || !uri || !this.player) return; // moved on, or silence (want stays: no retry every tick)
    await this.player.load(uri);
    if (this.want !== c || !this.player) return;
    this.player.setRate(this.rate);
    this.player.seek((this.t - c.t0) / 1000);
    this.pendingSeek = this.t;
    this.inPlayer = c;
    if (this.playing) this.player.play();
  }

  async play(): Promise<void> {
    if (this.playing || !this.replay) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
    this.lastTick = this.now();
    this.loading = this.ensure(this.t);
    await this.loading;
    if (this.playing) this.player?.play();
    this.timer ??= setInterval(() => this.tick(), 50);
    this.emit();
  }

  pause(): void {
    this.playing = false;
    this.player?.pause();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit();
  }

  async seek(t: number): Promise<void> {
    this.t = Math.max(0, Math.min(this.duration, t));
    this.lastTick = this.now();
    this.emit();
    await this.ensure(this.t);
  }

  setRate(r: Speed): void {
    this.rate = r;
    this.player?.setRate(r);
    this.emit();
  }

  /** When the item was written (ms), for tap-to-seek. */
  timeOf(itemId: string): number | null {
    return this.times.get(itemId) ?? null;
  }

  /** Tap on a page during playback: seek to the stroke under the finger, if any. Returns the time. */
  async tapAt(pageId: string, x: number, y: number, tol: number): Promise<number | null> {
    const items = this.items().get(pageId) ?? [];
    const id = hitTestPoint(items, { x, y }, tol);
    const t = id ? this.timeOf(id) : null;
    if (t !== null) await this.seek(t);
    return t;
  }

  /** Advances the time: from the audio while a chunk plays, by the clock through gaps (missing or silent). */
  tick(): void {
    if (!this.playing) return;
    const now = this.now();
    const c = this.inPlayer;
    const dt = (now - this.lastTick) * this.rate;
    if (c && this.player && !this.player.ended()) {
      const pos = c.t0 + this.player.position() * 1000;
      if (this.pendingSeek !== null) {
        // Until the player reports the seek target, run on the clock from it (never jump back to the old position).
        if (Math.abs(pos - this.pendingSeek) < 750) {
          this.pendingSeek = null;
          this.t = pos;
        } else this.t += dt;
      } else this.t = Math.max(this.t, pos);
      if (this.t >= c.t0 + c.dur) this.t = c.t0 + c.dur;
    } else {
      this.t += dt;
    }
    this.lastTick = now;
    if (this.t >= this.duration) {
      this.t = this.duration;
      this.pause();
      return;
    }
    const want = this.chunkAt(this.t);
    if (want !== this.want && !(c && this.player && !this.player.ended() && this.t < c.t0 + c.dur)) void this.ensure(this.t);
    this.emit();
  }

  close(): void {
    this.pause();
    this.player?.release();
    this.player = null;
    this.handle?.release();
    this.handle = null;
  }
}
