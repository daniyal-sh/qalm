/**
 * One lecture recording on this device (docs/lecture-mode.md §1–§2): the timeline clock, the ink log of the open page
 * docs, the session doc (timeline chunks, audio chunks, transcript), audio chunk rotation and the library's session
 * list. Platform-free: the audio backend, assets and transcription are injected (tests use fakes).
 */
import { LectureClock, LectureDoc, LectureLog, lectureDocId, type Library, type LectureEvent, type LectureState, type Page, type TranscriptSegment } from '@qalm/core';
import type * as Y from 'yjs';

import { isAdts, splitAdts } from './adts';
import type { AudioBackend, ChunkRecorder, RecordedChunk } from './audio.types';

/** Audio chunk length: standalone files, transcribed one by one (§1). */
export const AUDIO_CHUNK_MS = 120_000;
/** Timeline flush: this long after the last event, and at most this long after the first unflushed one. */
export const FLUSH_IDLE_MS = 1_000;
export const FLUSH_MAX_MS = 10_000;

export interface RecorderDeps {
  /** Opens (and keeps syncing) a doc until `release`. */
  openDoc(docId: string): Promise<{ doc: Y.Doc; release(): void }>;
  library(): Library | null;
  audio: AudioBackend;
  /** Stores a chunk's bytes as an asset (local, then uploaded, tagged with its session); returns its sha256. */
  putAudio(bytes: Uint8Array, mime: string, name: string, ctx: { notebookId: string; sessionId: string }): Promise<string>;
  /** Transcribes a finished chunk; resolves to segments relative to the chunk (or [] when it is queued for later). */
  transcribe?(chunk: RecordedChunk & { sha: string; t0: number }, ctx: { notebookId: string; sessionId: string }): Promise<TranscriptSegment[]>;
  transcriber: 'device' | 'cloud' | 'none';
  newId(): string;
  now?: () => number;
  chunkMs?: number;
  /** Errors that don't stop the recording (an upload, a transcription, an interruption): shown as a toast. */
  onError?(e: unknown): void;
  /**
   * True while the app is in the background (iPad, Android). Chunks are not rotated then: Android 14 won't start the
   * microphone service from the background and iOS may end the audio session between recorders, so the chunk keeps
   * recording (crash-safe ADTS) and rotates once the app is back; a long one is cut into pieces when it ends
   * (docs/lecture-mode.md §1).
   */
  isBackground?(): boolean;
  /** Native: the file the chunk starting at `t0` is written to (kept for crash recovery), or null when it ended. */
  onChunkFile?(file: { uri: string; t0: number } | null): void;
}

/** While in the background, a due rotation is looked at again this often (it happens on return to the foreground). */
export const BACKGROUND_ROTATE_RECHECK_MS = 30_000;
/**
 * While recording: the session doc's length is updated this often (so the server never takes a long background
 * stretch for a crashed app), and the mic is checked (the OS may have stopped it without an event).
 */
export const KEEPALIVE_MS = 60_000;

/** `pausing` / `resuming`: the transition is under way (the mic is being stopped or started); both lock the pen. */
export type RecorderState = 'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'resuming' | 'stopping';

export class LectureRecorder {
  state: RecorderState = 'idle';
  sessionId: string | null = null;
  notebookId: string | null = null;
  private clock: LectureClock;
  private log: LectureLog | null = null;
  private lec: LectureDoc | null = null;
  private docHandle: { release(): void } | null = null;
  private mic: ChunkRecorder | null = null;
  private offInterrupt: (() => void) | null = null;
  private chunkT0 = 0;
  /** A chunk is recording on the mic (so it is stopped exactly once). */
  private chunkOpen = false;
  private chunkTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  /** Every mic operation (start, stop, rotate, release) runs on this chain, one after another, never overlapping. */
  private micChain: Promise<unknown> = Promise.resolve();
  /** The start, pause or resume under way, so stop can wait for it. */
  private transition: Promise<unknown> | null = null;
  private pending: LectureEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private pages = new Map<string, { doc: Y.Doc; detach(): void }>();
  private shown: string | null = null;
  private listeners = new Set<() => void>();
  /** Chunk work (upload, transcription) still running: stop waits for it. */
  private work = new Set<Promise<void>>();
  /** Deleted on another device: no library or session doc writes any more. */
  private abandoned = false;
  private readonly now: () => number;

  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.clock = new LectureClock(this.now);
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** The timeline time (ms). */
  t(): number {
    return this.clock.t();
  }

  /** The pen is locked unless recording: while paused, and through every transition. */
  get penLocked(): boolean {
    return this.state !== 'recording' && this.state !== 'idle';
  }

  private mic$<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.micChain.then(fn, fn);
    this.micChain = run.catch(() => undefined);
    return run;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const tracked: Promise<T> = p.finally(() => {
      if (this.transition === tracked) this.transition = null;
    });
    this.transition = tracked;
    return tracked;
  }

  get active(): boolean {
    return this.state !== 'idle';
  }

  /** Starts a session on a notebook, with `page` (id and 1-based position) shown. Throws when the mic is refused. */
  start(notebookId: string, page: { id: string; n: number } | null): Promise<string> {
    if (this.state !== 'idle') return Promise.reject(new Error('Already recording'));
    this.state = 'starting';
    this.abandoned = false;
    this.emit();
    return this.track(this.startRun(notebookId, page));
  }

  private async startRun(notebookId: string, page: { id: string; n: number } | null): Promise<string> {
    try {
      if (!(await this.deps.audio.permission())) throw new Error('qalm can’t use the microphone. Allow it in your device settings to record.');
      const sessionId = this.deps.newId();
      const h = await this.deps.openDoc(lectureDocId(notebookId, sessionId));
      this.docHandle = h;
      this.lec = new LectureDoc(h.doc);
      this.sessionId = sessionId;
      this.notebookId = notebookId;
      this.clock = new LectureClock(this.now);
      const startedAt = this.now();
      this.lec.setMeta({ id: sessionId, notebookId, startedAt, durationMs: 0, state: 'recording', lastT: 0, transcriber: this.deps.transcriber });
      this.log = new LectureLog(() => this.clock.t(), (e) => this.push(e));
      this.mic = await this.deps.audio.open();
      this.offInterrupt = this.mic.onInterrupt?.((why) => void this.interrupted(why)) ?? null;
      this.clock.start();
      await this.mic$(() => this.startChunk());
      this.push({ t: 0, k: 'start', at: startedAt });
      for (const [pageId, p] of this.pages) this.reattach(pageId, p.doc);
      if (page) this.showPage(page.id, page.n);
      this.state = 'recording';
      this.startKeepalive();
      this.summary();
      this.flush();
      this.emit();
      return sessionId;
    } catch (e) {
      await this.teardown();
      throw e;
    }
  }

  /** Frees everything of the session (mic, timers, doc) and goes idle, writing nothing more. */
  private async teardown(): Promise<void> {
    this.stopKeepalive();
    if (this.chunkTimer) clearTimeout(this.chunkTimer);
    this.chunkTimer = null;
    this.offInterrupt?.();
    this.offInterrupt = null;
    const mic = this.mic;
    this.chunkOpen = false;
    await this.mic$(async () => mic?.release()).catch(() => undefined);
    this.deps.onChunkFile?.(null);
    this.mic = null;
    for (const p of this.pages.values()) p.detach();
    for (const [id, p] of this.pages) this.pages.set(id, { doc: p.doc, detach: () => undefined });
    this.log = null;
    this.docHandle?.release();
    this.docHandle = null;
    this.lec = null;
    this.sessionId = null;
    this.notebookId = null;
    this.state = 'idle';
    this.emit();
  }

  /** The editor reports every page doc it has open; the log follows the ones of the recording's notebook. */
  attachPage(pageId: string, page: Page | null): void {
    const cur = this.pages.get(pageId);
    if (!page) {
      cur?.detach();
      this.pages.delete(pageId);
      return;
    }
    if (cur?.doc === page.doc) return;
    cur?.detach();
    this.pages.set(pageId, { doc: page.doc, detach: this.log ? this.log.attach(pageId, page) : () => undefined });
    this.pageObjects.set(pageId, page);
  }

  private pageObjects = new Map<string, Page>();

  private reattach(pageId: string, doc: Y.Doc): void {
    const page = this.pageObjects.get(pageId);
    if (!page || page.doc !== doc || !this.log) return;
    this.pages.get(pageId)?.detach();
    this.pages.set(pageId, { doc, detach: this.log.attach(pageId, page) });
  }

  /** The page in view changed (logged as a `page` event while recording). */
  showPage(pageId: string, n: number): void {
    if (this.state !== 'recording' && this.state !== 'starting') {
      this.shown = pageId;
      return;
    }
    if (this.shown === pageId && this.lec && this.lec.events().length) return;
    this.shown = pageId;
    this.push({ t: this.clock.t(), k: 'page', p: pageId, n });
  }

  /** Pauses: the pen locks at once (`pausing`), the clock stops, then the chunk is closed. A second call is a no-op. */
  pause(): Promise<void> {
    if (this.state !== 'recording') return (this.transition ?? Promise.resolve()).then(() => undefined, () => undefined);
    this.state = 'pausing';
    this.log?.setEnabled(false);
    this.stopKeepalive();
    const t = this.clock.pause();
    this.emit();
    return this.track(
      (async () => {
        await this.mic$(() => this.endChunk());
        this.markPaused(t);
      })(),
    );
  }

  private markPaused(t: number): void {
    this.push({ t, k: 'pause' });
    this.lec?.setMeta({ state: 'paused', durationMs: t });
    this.flush();
    this.state = 'paused';
    this.summary();
    this.emit();
  }

  /**
   * Resumes: a new chunk starts on the same timeline; the pen unlocks only once the mic is recording again. If the mic
   * can't start, it is paused again (and says why).
   */
  resume(): Promise<void> {
    if (this.state !== 'paused') return (this.transition ?? Promise.resolve()).then(() => undefined, () => undefined);
    this.state = 'resuming';
    this.emit();
    return this.track(
      (async () => {
        const t = this.clock.t();
        this.clock.start();
        try {
          await this.mic$(() => this.startChunk());
        } catch (e) {
          this.clock.pause();
          if (this.state === 'resuming') {
            this.state = 'paused';
            this.emit();
          }
          this.deps.onError?.(new Error(`The microphone couldn’t start, so the recording is still paused. ${e instanceof Error ? e.message : ''}`.trim()));
          return;
        }
        if (this.state !== 'resuming') return;
        this.push({ t, k: 'resume' });
        this.log?.setEnabled(true);
        this.state = 'recording';
        this.startKeepalive();
        this.lec?.setMeta({ state: 'recording' });
        this.flush();
        this.summary();
        this.emit();
      })(),
    );
  }

  /**
   * Ends the session: last chunk saved (and transcribed), timeline flushed, doc released. Waits for a start, pause or
   * resume under way first (a failed one leaves it paused or idle), so it never leaves the recorder stuck.
   */
  async stop(): Promise<void> {
    while (this.transition) await this.transition.catch(() => undefined);
    if (this.state !== 'recording' && this.state !== 'paused') return;
    this.state = 'stopping';
    this.log?.setEnabled(false);
    this.stopKeepalive();
    this.emit();
    const t = this.clock.pause();
    await this.mic$(() => this.endChunk());
    this.push({ t, k: 'stop' });
    this.flush();
    await Promise.allSettled([...this.work]);
    if (!this.abandoned) {
      this.lec?.setMeta({ state: 'stopped', durationMs: t });
      this.summary();
    }
    await this.teardown();
  }

  /**
   * The session was deleted on another device (its sync ticket answers 410): stop recording without writing anything
   * more to it or to the library (that would bring it back).
   */
  async abandon(): Promise<void> {
    this.abandoned = true;
    this.pending = [];
    while (this.transition) await this.transition.catch(() => undefined);
    if (this.state === 'idle') return;
    this.state = 'stopping';
    this.emit();
    this.clock.pause();
    const mic = this.mic;
    const uri = mic?.currentUri?.() ?? null;
    await this.mic$(async () => {
      this.chunkOpen = false;
      await mic?.stop().catch(() => null);
    });
    if (uri) await this.deps.audio.discard?.(uri);
    await this.teardown();
  }

  /** The OS stopped the mic (a call, Siri, an error): pause, which releases the AI hold, and say so. */
  private async interrupted(why: string): Promise<void> {
    if (this.state !== 'recording') return;
    await this.pause();
    this.deps.onError?.(new Error(`Recording paused: ${why}. Resume when you’re ready.`));
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (this.state !== 'recording') return;
      if (this.chunkOpen && this.mic?.isRecording && !this.mic.isRecording()) {
        void this.interrupted('the microphone stopped');
        return;
      }
      if (!this.abandoned) this.lec?.setMeta({ durationMs: this.clock.t() });
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  // ---- timeline ----

  private push(e: LectureEvent): void {
    if (!this.lec || this.abandoned) return;
    if (!this.pending.length) this.firstPendingAt = this.now();
    this.pending.push(e);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const wait = Math.max(0, Math.min(FLUSH_IDLE_MS, this.firstPendingAt + FLUSH_MAX_MS - this.now()));
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  /** Writes pending events as one timeline chunk (synced with the session doc). */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.lec || !this.pending.length || this.abandoned) return;
    const events = this.pending;
    this.pending = [];
    this.lec.appendEvents(events);
  }

  // ---- audio chunks ----

  /** Only on the mic chain. Opens a chunk unless one is open. Throws when the mic can't start. */
  private async startChunk(): Promise<void> {
    if (!this.mic || this.chunkOpen) return;
    this.chunkT0 = this.clock.t();
    await this.mic.start();
    this.chunkOpen = true;
    const uri = this.mic.currentUri?.();
    if (uri) this.deps.onChunkFile?.({ uri, t0: this.chunkT0 });
    const ms = this.deps.chunkMs ?? AUDIO_CHUNK_MS;
    if (this.chunkTimer) clearTimeout(this.chunkTimer);
    this.chunkTimer = setTimeout(() => void this.rotate(), ms);
  }

  /**
   * Every couple of minutes: close the chunk (a standalone file) and start the next, as one mic operation. A next
   * chunk that can't start leaves the recording paused (never "recording" with no chunk and no timer).
   */
  private rotate(): Promise<void> {
    return this.mic$(async () => {
      if (this.state !== 'recording') return;
      if (this.deps.isBackground?.()) {
        if (this.chunkTimer) clearTimeout(this.chunkTimer);
        this.chunkTimer = setTimeout(() => void this.rotate(), BACKGROUND_ROTATE_RECHECK_MS);
        return;
      }
      await this.endChunk();
      if (this.state !== 'recording') return;
      try {
        await this.startChunk();
      } catch (e) {
        this.state = 'pausing';
        this.log?.setEnabled(false);
        this.stopKeepalive();
        this.markPaused(this.clock.pause());
        this.deps.onError?.(new Error(`The microphone stopped, so the recording is paused. ${e instanceof Error ? e.message : ''}`.trim()));
      }
    });
  }

  /** Only on the mic chain. Closes the open chunk (if any: a pause right after a rotation finds none to stop). */
  private async endChunk(): Promise<void> {
    if (this.chunkTimer) clearTimeout(this.chunkTimer);
    this.chunkTimer = null;
    if (!this.chunkOpen) return;
    this.chunkOpen = false;
    const t0 = this.chunkT0;
    const chunk = await this.mic?.stop().catch((e: unknown) => {
      this.deps.onError?.(e);
      return null;
    });
    this.deps.onChunkFile?.(null);
    if (!chunk || !this.lec || !this.sessionId || !this.notebookId || this.abandoned) {
      if (chunk?.uri) await this.deps.audio.discard?.(chunk.uri);
      return;
    }
    const lec = this.lec;
    const ctx = { notebookId: this.notebookId, sessionId: this.sessionId };
    const job = storeChunk(this.deps, lec, ctx, chunk, t0, this.deps.chunkMs ?? AUDIO_CHUNK_MS).catch((e: unknown) => this.deps.onError?.(e));
    this.work.add(job);
    void job.finally(() => this.work.delete(job));
  }

  // ---- library ----

  private summary(): void {
    const lib = this.deps.library();
    if (!lib || !this.lec || this.abandoned) return;
    const m = this.lec.meta();
    const state: LectureState = m.state;
    lib.putLecture({ id: m.id, notebookId: m.notebookId, startedAt: m.startedAt, durationMs: m.durationMs, state, ...(m.title ? { title: m.title } : {}) });
  }
}

/**
 * Stores one recorded chunk in the session: as is, or, when it is a long ADTS chunk (a background stretch, or a file
 * recovered after a crash), cut into pieces of at most `maxMs`, each its own asset, audio entry and transcription.
 * The recorder's file is deleted once its bytes are in the assets (and transcribed).
 */
export async function storeChunk(
  deps: Pick<RecorderDeps, 'putAudio' | 'transcribe' | 'audio'>,
  lec: LectureDoc,
  ctx: { notebookId: string; sessionId: string },
  chunk: RecordedChunk,
  t0: number,
  maxMs: number,
): Promise<void> {
  try {
    const long = isAdts(chunk.bytes) && (chunk.durMs > maxMs * 1.25 || !chunk.durMs);
    const pieces = long ? splitAdts(chunk.bytes, maxMs) : [{ bytes: chunk.bytes, t0: 0, dur: chunk.durMs }];
    for (const p of pieces) {
      const at = t0 + p.t0;
      const sha = await deps.putAudio(p.bytes, chunk.mime, `lecture-${ctx.sessionId}-${Math.round(at)}`, ctx);
      lec.addAudio({ sha, mime: chunk.mime, t0: at, dur: p.dur, bytes: p.bytes.length });
      if (!deps.transcribe) continue;
      // On-device recognizers read a file: a piece gets its own temporary one.
      const uri = long ? await deps.audio.writeTemp?.(p.bytes, '.aac') : chunk.uri;
      try {
        const segs = await deps.transcribe({ bytes: p.bytes, mime: chunk.mime, durMs: p.dur, ...(uri ? { uri } : {}), sha, t0: at }, ctx);
        lec.addTranscript(shift(segs, at));
      } finally {
        if (long && uri) await deps.audio.discard?.(uri);
      }
    }
  } finally {
    if (chunk.uri) await deps.audio.discard?.(chunk.uri);
  }
}

function shift(segs: readonly TranscriptSegment[], t0: number): TranscriptSegment[] {
  return segs.map((s) => ({
    ...s,
    t0: s.t0 + t0,
    t1: s.t1 + t0,
    ...(s.words ? { words: s.words.map((w) => ({ ...w, t0: w.t0 + t0, t1: w.t1 + t0 })) } : {}),
  }));
}

/**
 * A session this device left live (the app crashed or the tab closed mid-recording): ends it at its last saved event,
 * like Stop would have. Returns false when there was nothing to stop.
 */
export function stopLeftover(lec: LectureDoc, lib: Library | null): boolean {
  const m = lec.meta();
  if (!m.id || m.state === 'stopped') return false;
  const t = Math.max(m.lastT, m.durationMs);
  lec.appendEvents([{ t, k: 'stop' }]);
  lec.setMeta({ state: 'stopped', durationMs: t });
  lib?.putLecture(lec.summary());
  return true;
}
