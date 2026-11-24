/**
 * The app's one lecture recording (it outlives the editor screen, so leaving a notebook doesn't stop it) and the
 * wiring from the session: docs, assets, the library list and transcription (docs/lecture-mode.md).
 */
import { LectureDoc, lectureDocId, type Asset, type TranscriptSegment } from '@qalm/core';
import * as React from 'react';
import { AppState, Platform } from 'react-native';

import type { Session } from '../state/session';
import { newId } from '../lib/id';
import { kvGet, kvSet } from '../lib/kv';
import { openLoaded } from '../sync/docs';
import { AUDIO_MIME, audioBackend } from './audio';
import type { RecordedChunk } from './audio.types';
import { loadLecturePrefs } from './prefs';
import { removeLocalDoc } from '../sync/persistence';
import { adtsDurationMs } from './adts';
import { AUDIO_CHUNK_MS, LectureRecorder, stopLeftover, storeChunk } from './recorder';
import {
  cloudTranscribe,
  deviceRecognizer,
  drainQueue,
  dropQueuedSession,
  failedChunks,
  queueChunk,
  retryFailed,
  sessionDropped,
  shiftSegments,
  TranscribeError,
  type DrainResult,
  type PendingChunk,
} from './transcribe';

let current: LectureRecorder | null = null;
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const l of [...listeners]) l();
}

export function currentRecorder(): LectureRecorder | null {
  return current;
}

/**
 * The recorder (or null) and a version that moves on every state change (not with the clock: the editor re-renders
 * only when recording starts, pauses, resumes or stops). The running time is `useRecorderClock`, in a leaf component.
 */
export function useRecorder(): { rec: LectureRecorder | null; v: number } {
  const v = React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
  return { rec: current, v };
}

/** The recording's time (ms), refreshed 4× a second while it records. Use it in the small component that shows it. */
export function useRecorderClock(rec: LectureRecorder | null): number {
  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  const recording = rec?.state === 'recording';
  React.useEffect(() => {
    if (!rec) return;
    const off = rec.subscribe(tick);
    const t = recording ? setInterval(tick, 250) : null;
    return () => {
      off();
      if (t) clearInterval(t);
    };
  }, [rec, recording]);
  return rec?.t() ?? 0;
}

/**
 * Sessions this device has live (recording or paused), per account, with the file the current chunk is being written
 * to (native): a crash or a closed tab leaves them behind, and the next start recovers them.
 */
interface LiveSession { notebookId: string; sessionId: string; file?: { uri: string; t0: number } | null }
const liveKey = (userId: string) => `lecture:live:${userId}`;

async function updateLive(userId: string, sessionId: string, f: (x: LiveSession | undefined) => LiveSession | null): Promise<void> {
  const all = (await kvGet<LiveSession[]>(liveKey(userId))) ?? [];
  const next = f(all.find((y) => y.sessionId === sessionId));
  const rest = all.filter((y) => y.sessionId !== sessionId);
  const out = next ? [...rest, next] : rest;
  await kvSet(liveKey(userId), out.length ? out : undefined);
}

/** The server's word on a session: `deleted` (on another device), `live`, or null when it can't be asked (offline). */
async function sessionStatus(s: Session, x: LiveSession): Promise<'live' | 'deleted' | null> {
  if (!s.tm) return null;
  try {
    const r = await s.tm.fetch(`/lectures/${encodeURIComponent(x.notebookId)}/${encodeURIComponent(x.sessionId)}`);
    if (r.status === 404 || r.status === 410) return 'deleted';
    if (!r.ok) return null;
    return ((await r.json()) as { deleted?: boolean }).deleted ? 'deleted' : 'live';
  } catch {
    return null;
  }
}

/** Removes a session deleted elsewhere from this device: library entry, local doc, queued uploads and transcriptions. */
async function forgetSession(s: Session, notebookId: string, sessionId: string, audioShas: string[] = []): Promise<void> {
  const docId = lectureDocId(notebookId, sessionId);
  if (s.user) await dropQueuedSession(s.user.id, sessionId).catch(() => undefined);
  await s.assets.dropPending(audioShas, docId).catch(() => undefined);
  s.library?.removeLecture(sessionId);
  await s.dm.drop(docId).catch(() => undefined);
  await removeLocalDoc(docId).catch(() => undefined);
}

/**
 * On app start: a session this device left recording or paused (the app crashed, the tab closed) is stopped, so it
 * doesn't show as live forever (docs/lecture-mode.md §3). Its audio up to the last saved chunk stays, and the chunk
 * that was recording when it died (crash-safe ADTS) is recovered from its file. A session deleted on another device
 * meanwhile stays deleted (only its leftover file goes); offline, nothing is decided until the next start.
 */
export async function stopLeftoverSessions(s: Session): Promise<number> {
  const userId = s.user?.id;
  if (!userId || current?.active) return 0;
  const left = (await kvGet<LiveSession[]>(liveKey(userId))) ?? [];
  let n = 0;
  const done: string[] = [];
  for (const x of left) {
    const status = await sessionStatus(s, x);
    if (status === null) continue;
    if (status === 'deleted') {
      if (x.file) await audioBackend.discard?.(x.file.uri);
      await forgetSession(s, x.notebookId, x.sessionId);
      done.push(x.sessionId);
      continue;
    }
    try {
      const h = await openLoaded(s.dm, lectureDocId(x.notebookId, x.sessionId), 3000);
      try {
        const lec = new LectureDoc(h.doc);
        if (x.file && lec.meta().state !== 'stopped') await recoverChunk(s, userId, lec, x, x.file);
        if (stopLeftover(lec, s.library)) n++;
      } finally {
        h.release();
      }
      done.push(x.sessionId);
    } catch {
      /* unreadable now: tried again at the next start */
    }
  }
  // Only the entries handled here go: a recording started meanwhile keeps its mark.
  const now = (await kvGet<LiveSession[]>(liveKey(userId))) ?? [];
  const keep = now.filter((y) => !done.includes(y.sessionId));
  await kvSet(liveKey(userId), keep.length ? keep : undefined);
  return n;
}

/** The chunk a crash cut off: its file is ADTS, readable as it is. Stored (in 2-minute pieces) and then deleted. */
async function recoverChunk(s: Session, userId: string, lec: LectureDoc, x: LiveSession, file: { uri: string; t0: number }): Promise<void> {
  const bytes = await audioBackend.readFile?.(file.uri);
  if (!bytes?.length) return;
  const durMs = adtsDurationMs(bytes);
  if (!durMs) {
    await audioBackend.discard?.(file.uri);
    return;
  }
  const ctx = { notebookId: x.notebookId, sessionId: x.sessionId };
  const prefs = await loadLecturePrefs();
  const cloud = lec.meta().transcriber === 'cloud';
  await storeChunk(
    {
      audio: audioBackend,
      putAudio: async (b, mime, name) => (await s.assets.putUnchecked(b, mime, name, {}, { lecture: lectureDocId(x.notebookId, x.sessionId) })).sha256,
      // Recovered audio is transcribed with the cloud queue when the session used it (no recognizer runs at start).
      transcribe: cloud
        ? async (c) => {
            await queueChunk(userId, { ...ctx, sha: c.sha, mime: c.mime, t0: c.t0, dur: c.durMs, lang: prefs.lang });
            return [];
          }
        : undefined,
    },
    lec,
    ctx,
    { bytes, mime: AUDIO_MIME, durMs, uri: file.uri },
    file.t0,
    AUDIO_CHUNK_MS,
  );
  lec.setMeta({ durationMs: Math.max(lec.meta().durationMs, file.t0 + durMs) });
}

/** Sign-out (or account deletion): a recording in progress is stopped and saved first. */
export async function stopRecordingNow(): Promise<void> {
  if (current?.active) await current.stop().catch(() => undefined);
}

/**
 * A `lec:` doc's sync ticket answered 410: the session was deleted on another device. If it is recording here it is
 * abandoned (nothing more is written, so it can't come back), and it is removed from this device.
 */
export async function lectureGone(s: Session, docId: string): Promise<void> {
  const m = /^lec:([^:]+):([^:]+)$/.exec(docId);
  if (!m) return;
  const [, notebookId, sessionId] = m as unknown as [string, string, string];
  if (current?.sessionId === sessionId) await current.abandon().catch(() => undefined);
  if (s.user) await updateLive(s.user.id, sessionId, () => null).catch(() => undefined);
  await forgetSession(s, notebookId, sessionId);
}

let goneHandler: ((docId: string) => void) | null = null;
/** The app wires this to `lectureGone` with its session; the sync layer calls `notifyLectureGone`. */
export function setLectureGoneHandler(fn: ((docId: string) => void) | null): void {
  goneHandler = fn;
}
export function notifyLectureGone(docId: string): void {
  goneHandler?.(docId);
}

const audioAsset = (sha: string, mime: string): Asset => ({ id: sha, sha256: sha, mime, name: 'lecture audio', bytes: 0 });

/** Starts recording `notebookId` with this session's account. Throws a readable error when it can't. */
export async function startRecording(s: Session, notebookId: string, page: { id: string; n: number } | null, onError: (e: unknown) => void): Promise<void> {
  if (current?.active) throw new Error('A lecture is already recording');
  if (!s.user || !s.tm) throw new Error('Sign in to record lectures');
  const tm = s.tm;
  const userId = s.user.id;
  const prefs = await loadLecturePrefs();
  const device = prefs.cloud ? null : await deviceRecognizer(prefs.lang).catch(() => null);
  const transcriber = prefs.cloud ? 'cloud' : device?.available ? 'device' : 'none';
  const rec = new LectureRecorder({
    openDoc: async (docId) => {
      const h = await openLoaded(s.dm, docId);
      return { doc: h.doc, release: () => h.release() };
    },
    library: () => s.library,
    audio: audioBackend,
    // Tagged with its session: an upload that lands after the session was deleted is refused, not counted.
    putAudio: async (bytes, mime, name, ctx) => (await s.assets.putUnchecked(bytes, mime, name, {}, { lecture: lectureDocId(ctx.notebookId, ctx.sessionId) })).sha256,
    transcriber,
    transcribe:
      transcriber === 'none'
        ? undefined
        : async (chunk: RecordedChunk & { sha: string; t0: number }, ctx): Promise<TranscriptSegment[]> => {
            if (transcriber === 'device') return device!.transcribe!(chunk, prefs.lang);
            try {
              return await cloudTranscribe({ fetch: (p, i) => tm.fetch(p, i) }, chunk, prefs.lang);
            } catch (e) {
              if (e instanceof TranscribeError && e.retry) {
                await queueChunk(userId, { ...ctx, sha: chunk.sha, mime: chunk.mime, t0: chunk.t0, dur: chunk.durMs, lang: prefs.lang });
                return [];
              }
              throw e;
            }
          },
    newId,
    onError,
    // Native apps: no chunk rotation in the background (see RecorderDeps.isBackground).
    isBackground: () => Platform.OS !== 'web' && AppState.currentState !== 'active',
    // The file being recorded, kept with the live mark: a crash leaves it to be recovered at the next start.
    onChunkFile: (file) => {
      const sid = rec.sessionId;
      if (sid) void updateLive(userId, sid, (x) => (x ? { ...x, file } : null)).catch(() => undefined);
    },
  });
  const off = rec.subscribe(changed);
  current = rec;
  changed();
  let sessionId: string;
  try {
    sessionId = await rec.start(notebookId, page);
  } catch (e) {
    off();
    current = null;
    changed();
    throw e;
  }
  const live = { notebookId, sessionId };
  await updateLive(userId, sessionId, (x) => ({ ...live, file: x?.file ?? null })).catch(() => undefined);
  // Once stopped, the next Record makes a new recorder.
  const offIdle = rec.subscribe(() => {
    if (rec.state === 'idle' && current === rec) {
      off();
      offIdle();
      current = null;
      changed();
      void updateLive(userId, live.sessionId, () => null).catch(() => undefined);
      void retryTranscriptions(s);
    }
  });
}

let draining: Promise<void> | null = null;

/**
 * Cloud chunks that couldn't be sent (offline, rate-limited) go now. Called after a recording, on app start and on
 * Retry. Each chunk is tried a few times over the drains, then listed as failed (Retry in the Lectures list). A drain
 * stops when the signed-in account changes (the rest stays queued for its own account).
 */
export function retryTranscriptions(s: Session): Promise<void> {
  if (!s.tm || !s.user) return Promise.resolve();
  const tm = s.tm;
  const userId = s.user.id;
  draining ??= drainQueue(
    userId,
    async (p: PendingChunk): Promise<DrainResult> => {
      const bytes = await s.assets.bytes(audioAsset(p.sha, p.mime)).catch(() => null);
      if (!bytes) return 'done'; // the audio is gone: nothing to do
      let segs: TranscriptSegment[];
      try {
        segs = await cloudTranscribe({ fetch: (path, i) => tm.fetch(path, i) }, { bytes, mime: p.mime, durMs: p.dur }, p.lang);
      } catch (e) {
        return e instanceof TranscribeError && e.retry ? 'retry' : 'failed';
      }
      if (sessionDropped(p.sessionId)) return 'done'; // deleted while it was being transcribed: never write it back
      const h = await openLoaded(s.dm, lectureDocId(p.notebookId, p.sessionId));
      try {
        new LectureDoc(h.doc).addTranscript(shiftSegments(segs, p.t0));
      } finally {
        h.release();
      }
      return 'done';
    },
    () => tm.user()?.id === userId,
  ).finally(() => {
    draining = null;
    failedChanged();
  });
  return draining;
}

/** Sign-out waits for a drain in flight (so none of this account's chunks go out once it is signed out). */
export function drainDone(): Promise<void> {
  return draining ?? Promise.resolve();
}

const failedListeners = new Set<() => void>();
function failedChanged(): void {
  for (const l of [...failedListeners]) l();
}

/** This account's sessions with transcription given up (session id → chunks), for "Transcription failed · Retry". */
export function useFailedTranscriptions(userId: string | null): Map<string, number> {
  const [m, setM] = React.useState(new Map<string, number>());
  React.useEffect(() => {
    if (!userId) return;
    let alive = true;
    const load = () =>
      void failedChunks(userId).then((all) => {
        if (!alive) return;
        const next = new Map<string, number>();
        for (const p of all) next.set(p.sessionId, (next.get(p.sessionId) ?? 0) + 1);
        setM(next);
      });
    load();
    failedListeners.add(load);
    return () => {
      alive = false;
      failedListeners.delete(load);
    };
  }, [userId]);
  return m;
}

/** Retry for a session's failed transcription: back in the queue, and a drain now. */
export async function retrySessionTranscription(s: Session, sessionId: string): Promise<void> {
  if (!s.user) return;
  await retryFailed(s.user.id, sessionId);
  failedChanged();
  await retryTranscriptions(s);
}

/** A playable uri for an audio chunk (local, or downloaded once). */
export function chunkUri(s: Session, sha: string, mime: string): Promise<string | null> {
  return s.assets.uri(audioAsset(sha, mime));
}

/** Asset bytes for export (audio, crop PNGs). */
export function lectureAssetBytes(s: Session, sha: string, mime: string): Promise<Uint8Array | null> {
  return s.assets.bytes(audioAsset(sha, mime)).catch(() => null);
}
