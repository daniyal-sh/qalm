/**
 * Transcription (docs/lecture-mode.md §4): each finished audio chunk becomes timed segments on the session's
 * timeline, on the device by default or with Whisper on the server ("Cloud transcription"). A chunk that can't be
 * sent (offline, rate limit) is queued and retried.
 */
import type { TranscriptSegment } from '@qalm/core';
import { QalmLecture } from 'qalm-lecture';
import { Platform } from 'react-native';

import { desktop } from '../lib/desktop';
import { kvGet, kvSet } from '../lib/kv';
import { decodeToWav } from './wav';

export interface Fetcher { fetch(path: string, init?: RequestInit): Promise<Response> }

/** What this device can do without the cloud. */
export interface DeviceRecognizer {
  available: boolean;
  /** Why not, in a sentence for Settings. */
  why?: string;
  transcribe?(chunk: { bytes: Uint8Array; mime: string; uri?: string }, lang: string): Promise<TranscriptSegment[]>;
}

/** The on-device recognizer here: Apple's on iPad and Mac, Android's where supported; none on Windows and web. */
export async function deviceRecognizer(lang: string): Promise<DeviceRecognizer> {
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    if (!QalmLecture) return { available: false, why: 'This build has no speech recognizer.' };
    const r = await QalmLecture.isAvailable(lang).catch(() => ({ available: false, why: 'The speech recognizer could not start.' }));
    if (!r.available) return { available: false, why: r.why ?? 'On-device speech recognition isn’t available on this device.' };
    return {
      available: true,
      transcribe: async (chunk, l) => {
        if (!chunk.uri) throw new Error('no audio file');
        return normalize(await QalmLecture!.transcribeFile(chunk.uri, l), 'device');
      },
    };
  }
  const d = desktop();
  if (d?.lectureTranscribe) {
    const r = await d.lectureTranscribeAvailable?.(lang).catch(() => false);
    if (r) {
      // The helper gets WAV: AVFoundation can't read the WebM/Opus that MediaRecorder makes.
      return {
        available: true,
        transcribe: async (chunk, l) => {
          const wav = /wav/.test(chunk.mime) ? chunk.bytes : await decodeToWav(chunk.bytes);
          return normalize(await d.lectureTranscribe!(wav, 'audio/wav', l), 'device');
        },
      };
    }
  }
  return { available: false, why: 'There’s no on-device speech recognizer on this computer. Turn on cloud transcription to get a transcript.' };
}

function normalize(segs: TranscriptSegment[], src: 'device' | 'cloud'): TranscriptSegment[] {
  return segs.filter((s) => s.text?.trim()).map((s) => ({ ...s, text: s.text.trim(), src }));
}

export class TranscribeError extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
  }
}

/** POST /lectures/transcribe with one chunk. Times are relative to the chunk. */
export async function cloudTranscribe(api: Fetcher, chunk: { bytes: Uint8Array; mime: string; durMs: number }, lang: string): Promise<TranscriptSegment[]> {
  const q = lang ? `?lang=${encodeURIComponent(lang.slice(0, 2).toLowerCase())}` : '';
  let res: Response;
  try {
    res = await api.fetch(`/lectures/transcribe${q}`, {
      method: 'POST',
      headers: { 'Content-Type': chunk.mime, 'X-Audio-Duration-Ms': String(Math.round(chunk.durMs)) },
      body: chunk.bytes as unknown as BodyInit,
    });
  } catch {
    throw new TranscribeError('offline', true);
  }
  if (res.ok) return normalize(((await res.json()) as { segments: TranscriptSegment[] }).segments ?? [], 'cloud');
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  // Rate limits and server trouble are retried; a quota or a bad request isn't.
  throw new TranscribeError(body.error ?? `Transcription failed (${res.status})`, res.status === 429 || res.status >= 500);
}

/** A chunk waiting for (cloud) transcription: its audio is a local asset. `attempts`: failed tries so far. */
export interface PendingChunk { notebookId: string; sessionId: string; sha: string; mime: string; t0: number; dur: number; lang: string; attempts?: number }
/**
 * The queue is per account (`lecture:pending-asr:{userId}`): after a sign-out and another sign-in, one account's audio
 * is never sent with another's token or counted against its minutes. Sign-out and account deletion clear it.
 */
const pendingKey = (userId: string) => `lecture:pending-asr:${userId}`;
/** Chunks given up on (too many failed tries, or an error that won't go away by itself): the Lectures list offers Retry. */
const failedKey = (userId: string) => `lecture:failed-asr:${userId}`;
const same = (a: PendingChunk, b: PendingChunk) => a.sha === b.sha && a.sessionId === b.sessionId;
/** A chunk is tried this many times (one try per drain: after a recording, on app start, on Retry), then it fails. */
export const MAX_ASR_ATTEMPTS = 5;

/** What a try of a queued chunk came to. */
export type DrainResult = 'done' | 'retry' | 'failed';

export async function queueChunk(userId: string, p: PendingChunk): Promise<void> {
  const all = (await kvGet<PendingChunk[]>(pendingKey(userId))) ?? [];
  if (!all.some((x) => same(x, p))) await kvSet(pendingKey(userId), [...all, p]);
}

export async function pendingChunks(userId: string): Promise<PendingChunk[]> {
  return (await kvGet<PendingChunk[]>(pendingKey(userId))) ?? [];
}

export async function failedChunks(userId: string): Promise<PendingChunk[]> {
  return (await kvGet<PendingChunk[]>(failedKey(userId))) ?? [];
}

/** Retry for a session's failed chunks: back in the queue with a fresh count. */
export async function retryFailed(userId: string, sessionId: string): Promise<number> {
  const failed = await failedChunks(userId);
  const mine = failed.filter((x) => x.sessionId === sessionId);
  if (!mine.length) return 0;
  await kvSet(failedKey(userId), failed.length > mine.length ? failed.filter((x) => x.sessionId !== sessionId) : undefined);
  for (const p of mine) await queueChunk(userId, { ...p, attempts: 0 });
  return mine.length;
}

/** Forgets a deleted session's queued (and failed) chunks: they would otherwise recreate it when transcribed. */
export async function dropQueuedSession(userId: string, sessionId: string): Promise<void> {
  dropped.add(sessionId);
  for (const key of [pendingKey(userId), failedKey(userId)]) {
    const all = (await kvGet<PendingChunk[]>(key)) ?? [];
    const left = all.filter((x) => x.sessionId !== sessionId);
    if (left.length !== all.length) await kvSet(key, left.length ? left : undefined);
  }
}

/** Sign-out and account deletion: the account's queue (and failed list) goes. */
export async function clearQueue(userId: string): Promise<void> {
  await kvSet(pendingKey(userId), undefined);
  await kvSet(failedKey(userId), undefined);
}

/** Sessions deleted while a drain may be running: its results for them are thrown away. */
const dropped = new Set<string>();

/**
 * Tries each queued chunk once. `done`: transcribed (or nothing left to do); `retry`: kept for the next drain, up to
 * MAX_ASR_ATTEMPTS tries, then failed; `failed`: given up at once (e.g. the monthly quota). `alive` is checked
 * before each chunk: the drain stops (keeping the rest) when it says no, e.g. the account changed.
 */
export async function drainQueue(userId: string, run: (p: PendingChunk) => Promise<DrainResult | boolean>, alive: () => boolean = () => true): Promise<void> {
  const all = await pendingChunks(userId);
  const left: PendingChunk[] = [];
  const failed: PendingChunk[] = [];
  for (const p of all) {
    if (dropped.has(p.sessionId)) continue;
    if (!alive()) {
      left.push(p);
      continue;
    }
    let r: DrainResult;
    try {
      const v = await run(p);
      r = v === true ? 'done' : v === false ? 'retry' : v;
    } catch {
      r = 'retry';
    }
    if (r === 'done') continue;
    const attempts = (p.attempts ?? 0) + 1;
    if (r === 'failed' || attempts >= MAX_ASR_ATTEMPTS) failed.push({ ...p, attempts });
    else left.push({ ...p, attempts });
  }
  // Chunks queued while draining are kept; chunks of sessions deleted meanwhile are not.
  const now = await pendingChunks(userId);
  const fresh = now.filter((x) => !all.some((y) => same(x, y)));
  const keep = [...left, ...fresh].filter((x) => !dropped.has(x.sessionId));
  await kvSet(pendingKey(userId), keep.length ? keep : undefined);
  if (failed.length) {
    const before = await failedChunks(userId);
    const add = failed.filter((x) => !dropped.has(x.sessionId) && !before.some((y) => same(x, y)));
    if (add.length) await kvSet(failedKey(userId), [...before, ...add]);
  }
}

/** Whether a session was deleted on this device (its queued transcripts must not be written). */
export function sessionDropped(sessionId: string): boolean {
  return dropped.has(sessionId);
}

/** Shifts a chunk's segments onto the session timeline. */
export function shiftSegments(segs: readonly TranscriptSegment[], t0: number): TranscriptSegment[] {
  return segs.map((s) => ({
    ...s,
    t0: s.t0 + t0,
    t1: s.t1 + t0,
    ...(s.words ? { words: s.words.map((w) => ({ ...w, t0: w.t0 + t0, t1: w.t1 + t0 })) } : {}),
  }));
}
