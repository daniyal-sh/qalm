import { LectureDoc, Library, lectureDocId } from '@qalm/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Lecture mode, second review: recorder failures and interruptions, long background chunks (ADTS, split), crash
// recovery, sessions deleted elsewhere, the transcription retry cap, tagged uploads.

const kv = new Map<string, unknown>();
vi.mock('../src/lib/kv', () => ({
  kvGet: async (k: string) => (kv.has(k) ? JSON.parse(JSON.stringify(kv.get(k))) : undefined),
  kvSet: async (k: string, v: unknown) => void (v === undefined ? kv.delete(k) : kv.set(k, v)),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active' }, Alert: { alert: () => undefined } }));
vi.mock('qalm-lecture', () => ({ QalmLecture: null }));
vi.mock('../src/lib/desktop', () => ({ desktop: () => null }));
const removedLocal: string[] = [];
vi.mock('../src/sync/persistence', () => ({ listLocalDocs: async () => [], removeLocalDoc: async (d: string) => void removedLocal.push(d), openPersistence: () => null }));
const docs = new Map<string, Y.Doc>();
vi.mock('../src/sync/docs', async (orig) => ({
  ...(await orig<typeof import('../src/sync/docs')>()),
  openLoaded: async (_dm: unknown, id: string) => {
    if (!docs.has(id)) docs.set(id, new Y.Doc());
    return { doc: docs.get(id)!, release: () => undefined };
  },
}));
/** The native backend's file side, in memory. */
const files = new Map<string, Uint8Array>();
const discarded: string[] = [];
vi.mock('../src/lecture/audio', () => ({
  AUDIO_MIME: 'audio/aac',
  audioBackend: {
    permission: async () => true,
    open: async () => {
      throw new Error('not used here');
    },
    writeTemp: async (b: Uint8Array) => {
      const uri = `temp://${files.size}`;
      files.set(uri, b);
      return uri;
    },
    discard: async (uri: string) => void (discarded.push(uri), files.delete(uri)),
    readFile: async (uri: string) => files.get(uri) ?? null,
  },
}));
const localAssets = new Map<string, Uint8Array>();
vi.mock('../src/assets/local', () => ({
  sha256: async (b: Uint8Array) => `sha${b.length}x${b[7] ?? 0}`.padEnd(64, '0'),
  saveLocal: async (sha: string, _m: string, b: Uint8Array) => void localAssets.set(sha, b),
  readLocal: async (sha: string) => localAssets.get(sha) ?? null,
  localUri: async () => null,
}));

const { LectureRecorder, storeChunk } = await import('../src/lecture/recorder');
const { holdAiWhileRecording } = await import('../src/lecture/aiHold');
const { adtsFrames, adtsDurationMs, splitAdts, isAdts } = await import('../src/lecture/adts');
const { queueChunk, drainQueue, pendingChunks, failedChunks, retryFailed, MAX_ASR_ATTEMPTS } = await import('../src/lecture/transcribe');
const store = await import('../src/lecture/store');
const { AssetService } = await import('../src/assets/assetService');
type AudioBackend = import('../src/lecture/audio.types').AudioBackend;
type ChunkRecorder = import('../src/lecture/audio.types').ChunkRecorder;

beforeEach(() => vi.useFakeTimers({ now: 1_764_000_000_000 }));
afterEach(() => vi.useRealTimers());
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** ADTS AAC at 22.05 kHz: `ms` of 1024-sample frames, each 27 bytes (7-byte header + 20 of payload). */
function adts(ms: number, cutLast = false): Uint8Array {
  const n = Math.round((ms * 22050) / 1024 / 1000);
  const len = 27;
  const out = new Uint8Array(n * len);
  for (let i = 0; i < n; i++) {
    const at = i * len;
    out.set([0xff, 0xf1, 0x40 | (7 << 2), 0x40 | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc], at);
  }
  return cutLast ? out.subarray(0, out.length - 10) : out; // a crash cut the last frame
}

/** A scriptable microphone: `failStart` makes the next starts throw; `interrupt()` plays an OS interruption. */
function scriptedMic(log: string[]) {
  let started = 0;
  let open = false;
  let recording = true;
  const failStart = { n: 0 };
  const listeners = new Set<(why: string) => void>();
  let bytes: (() => Uint8Array) | null = null;
  const mic: ChunkRecorder = {
    start: async () => {
      if (failStart.n > 0) {
        failStart.n--;
        log.push('start failed');
        throw new Error('mic busy');
      }
      open = true;
      recording = true;
      started = Date.now();
      log.push('start');
    },
    stop: async () => {
      if (!open) throw new Error('stopped twice');
      open = false;
      log.push('stop');
      const b = bytes ? bytes() : new Uint8Array([1, 2, 3]);
      return { bytes: b, mime: 'audio/aac', durMs: Date.now() - started, uri: `rec://${log.length}` };
    },
    release: async () => void log.push('release'),
    onInterrupt: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    isRecording: () => open && recording,
    currentUri: () => (open ? 'rec://current' : null),
  };
  const backend: AudioBackend = {
    permission: async () => true,
    open: async () => mic,
    writeTemp: async (b) => {
      const uri = `temp://${files.size}-${Math.random()}`;
      files.set(uri, b);
      return uri;
    },
    discard: async (uri) => void (discarded.push(uri), files.delete(uri)),
  };
  return {
    backend,
    failStart,
    interrupt: (why: string) => [...listeners].forEach((l) => l(why)),
    stopRecordingSilently: () => void (recording = false),
    setBytes: (f: () => Uint8Array) => void (bytes = f),
  };
}

function recorder(backend: AudioBackend, extra: Partial<ConstructorParameters<typeof LectureRecorder>[0]> = {}) {
  const docsR = new Map<string, Y.Doc>();
  const errors: string[] = [];
  const lib = new Library(new Y.Doc());
  const rec = new LectureRecorder({
    openDoc: async (id) => {
      if (!docsR.has(id)) docsR.set(id, new Y.Doc());
      return { doc: docsR.get(id)!, release: () => undefined };
    },
    library: () => lib,
    audio: backend,
    putAudio: async (b) => `sha-${b.length}`.padEnd(64, '0'),
    transcriber: 'none',
    newId: () => 's1',
    chunkMs: 120_000,
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
    ...extra,
  });
  return { rec, lib, errors, lec: () => new LectureDoc(docsR.get(lectureDocId('nb1', 's1'))!) };
}

describe('recorder failures never leave it stuck (and release the AI hold)', () => {
  it('a resume whose mic can’t start goes back to paused; stop then works; the hold is released', async () => {
    const log: string[] = [];
    const m = scriptedMic(log);
    const { rec, errors } = recorder(m.backend);
    const holds: string[] = [];
    holdAiWhileRecording(rec, (r) => (holds.push(`+${r}`), () => holds.push(`-${r}`)));
    await rec.start('nb1', null);
    await rec.pause();
    m.failStart.n = 1;
    await rec.resume();
    expect(rec.state).toBe('paused');
    expect(rec.penLocked).toBe(true);
    expect(errors.join()).toMatch(/couldn’t start/);
    expect(holds).toEqual(['+lecture', '-lecture', '+lecture', '-lecture']); // taken for resuming, released on failure
    await rec.stop();
    expect(rec.state).toBe('idle');
    // Record works again (no "already recording").
    await rec.start('nb1', null);
    expect(rec.state).toBe('recording');
    await rec.stop();
  });

  it('stop during starting or resuming waits, then stops', async () => {
    const m = scriptedMic([]);
    const { rec } = recorder(m.backend);
    const started = rec.start('nb1', null);
    const stopped = rec.stop();
    await started;
    await stopped;
    expect(rec.state).toBe('idle');
    await rec.start('nb1', null);
    await rec.pause();
    void rec.resume();
    await rec.stop();
    expect(rec.state).toBe('idle');
  });

  it('an OS interruption (a call, Siri) pauses and says why; a mic that stopped by itself is caught by the keepalive', async () => {
    const m = scriptedMic([]);
    const { rec, errors } = recorder(m.backend);
    await rec.start('nb1', null);
    m.interrupt('a phone call');
    await later(10);
    expect(rec.state).toBe('paused');
    expect(errors.at(-1)).toMatch(/Recording paused: a phone call/);
    await rec.resume();
    expect(rec.state).toBe('recording');
    m.stopRecordingSilently();
    await later(60_000);
    expect(rec.state).toBe('paused');
    await rec.stop();
  });

  it('a rotation whose next chunk can’t start leaves it paused (not recording with no chunk)', async () => {
    const log: string[] = [];
    const m = scriptedMic(log);
    const { rec, errors } = recorder(m.backend);
    await rec.start('nb1', null);
    m.failStart.n = 1;
    await later(120_000);
    expect(log).toEqual(['start', 'stop', 'start failed']);
    expect(rec.state).toBe('paused');
    expect(errors.at(-1)).toMatch(/microphone stopped/);
    await rec.stop();
    expect(rec.state).toBe('idle');
  });

  it('keeps the session doc fresh while recording (the server never takes a long background stretch for a crash)', async () => {
    const m = scriptedMic([]);
    const { rec, lec } = recorder(m.backend, { isBackground: () => true });
    await rec.start('nb1', null);
    await later(5 * 60_000);
    expect(lec().meta().durationMs).toBeGreaterThanOrEqual(4 * 60_000);
    await rec.stop();
  });
});

describe('long background chunks: ADTS, cut into 2-minute pieces', () => {
  it('reads frames, drops a cut-off last frame, and splits', () => {
    const b = adts(300_000, true);
    expect(isAdts(b)).toBe(true);
    const frames = adtsFrames(b);
    expect(frames.length).toBe(Math.round((300_000 * 22050) / 1024 / 1000) - 1);
    expect(Math.abs(adtsDurationMs(b) - 300_000)).toBeLessThan(100);
    const pieces = splitAdts(b, 120_000);
    expect(pieces.map((p) => p.t0)).toEqual([0, pieces[1]!.t0, pieces[2]!.t0]);
    expect(pieces.every((p) => p.dur <= 120_000 && isAdts(p.bytes))).toBe(true);
    expect(pieces.reduce((n, p) => n + p.bytes.length, 0)).toBe(frames.length * 27);
  });

  it('a 5-minute background chunk is stored as 3 chunks, each transcribed from its own file; files are deleted', async () => {
    const m = scriptedMic([]);
    const seen: { t0: number; dur: number; uri?: string }[] = [];
    const { rec, lec } = recorder(m.backend, {
      isBackground: () => true,
      transcriber: 'device',
      transcribe: async (c) => (seen.push({ t0: c.t0, dur: c.durMs, uri: c.uri }), [{ t0: 0, t1: 500, text: `at ${c.t0}` }]),
    });
    m.setBytes(() => adts(300_000));
    discarded.length = 0;
    await rec.start('nb1', null);
    await later(300_000);
    await rec.stop();
    const audio = lec().audio();
    expect(audio).toHaveLength(3);
    expect(audio.every((a) => a.dur <= 120_000)).toBe(true);
    expect(audio[1]!.t0).toBeGreaterThan(100_000);
    expect(seen.map((x) => x.uri?.startsWith('temp://'))).toEqual([true, true, true]);
    expect(lec().transcript().map((s) => s.t0)).toEqual(audio.map((a) => a.t0));
    // The temporary piece files and the recorder's own file are gone.
    expect(discarded.filter((u) => u.startsWith('temp://'))).toHaveLength(3);
    expect(discarded.some((u) => u.startsWith('rec://'))).toBe(true);
  });

  it('a normal chunk is stored as is, and its recorder file deleted', async () => {
    discarded.length = 0;
    const lec = new LectureDoc(new Y.Doc());
    const put: number[] = [];
    await storeChunk({ audio: { permission: async () => true, open: async () => ({}) as ChunkRecorder, discard: async (u) => void discarded.push(u) }, putAudio: async (b) => (put.push(b.length), 'a'.repeat(64)) }, lec, { notebookId: 'nb', sessionId: 's' }, { bytes: adts(60_000), mime: 'audio/aac', durMs: 60_000, uri: 'rec://x' }, 1000, 120_000);
    expect(lec.audio()).toEqual([expect.objectContaining({ t0: 1000, dur: 60_000 })]);
    expect(discarded).toEqual(['rec://x']);
  });
});

/** A Session stand-in for the store's functions. */
function session(statusFor: (sid: string) => number | Error) {
  const lib = new Library(new Y.Doc());
  const dropped: string[] = [];
  const assets = { putUnchecked: async (b: Uint8Array) => ({ sha256: `put${b.length}`.padEnd(64, '0') }), dropPending: async () => undefined, bytes: async () => new Uint8Array() };
  const s = {
    user: { id: 'u1' },
    tm: {
      user: () => ({ id: 'u1' }),
      fetch: async (path: string) => {
        const sid = path.split('/').pop()!;
        const st = statusFor(sid);
        if (st instanceof Error) throw st;
        return new Response(JSON.stringify({ deleted: st === 410 }), { status: st === 410 ? 200 : st });
      },
    },
    dm: { drop: async (id: string) => void dropped.push(id) },
    library: lib,
    assets,
  };
  return { s: s as unknown as Parameters<typeof store.stopLeftoverSessions>[0], lib, dropped };
}

describe('sessions left live by a crash', () => {
  it('recovers the chunk that was recording from its file, stops the session, deletes the file', async () => {
    kv.clear();
    files.clear();
    discarded.length = 0;
    const id = lectureDocId('nb1', 'c1');
    const lec = new LectureDoc(new Y.Doc());
    lec.setMeta({ id: 'c1', notebookId: 'nb1', startedAt: 1, state: 'recording', transcriber: 'none', durationMs: 120_000 });
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }]);
    docs.set(id, lec.doc);
    files.set('rec://crashed', adts(200_000, true));
    kv.set('lecture:live:u1', [{ notebookId: 'nb1', sessionId: 'c1', file: { uri: 'rec://crashed', t0: 120_000 } }]);
    const { s, lib } = session(() => 200);
    expect(await store.stopLeftoverSessions(s)).toBe(1);
    const back = new LectureDoc(docs.get(id)!);
    expect(back.meta().state).toBe('stopped');
    expect(back.audio().map((a) => a.t0)).toEqual([120_000, back.audio()[1]!.t0]);
    expect(back.meta().durationMs).toBeGreaterThan(310_000);
    expect(discarded).toContain('rec://crashed');
    expect(lib.lectures('nb1')[0]).toMatchObject({ id: 'c1', state: 'stopped' });
    expect(kv.has('lecture:live:u1')).toBe(false);
  });

  it('a session deleted on another device stays deleted; offline, nothing is decided; a newer live mark survives', async () => {
    kv.clear();
    const { s, lib } = session((sid) => (sid === 'gone' ? 410 : new Error('offline')));
    lib.putLecture({ id: 'gone', notebookId: 'nb1', startedAt: 1, durationMs: 5, state: 'recording' });
    kv.set('lecture:live:u1', [
      { notebookId: 'nb1', sessionId: 'gone' },
      { notebookId: 'nb1', sessionId: 'later' },
    ]);
    removedLocal.length = 0;
    await store.stopLeftoverSessions(s);
    expect(lib.lectures().map((l) => l.id)).toEqual([]); // not put back
    expect(removedLocal).toContain(lectureDocId('nb1', 'gone'));
    expect((kv.get('lecture:live:u1') as { sessionId: string }[]).map((x) => x.sessionId)).toEqual(['later']);
  });
});

describe('a session deleted elsewhere while it records here (sync ticket 410)', () => {
  it('abandons the recording and removes it, without putting it back in the library', async () => {
    kv.clear();
    const { s, lib } = session(() => 200);
    const mic = scriptedMic([]);
    const { rec, lib: recLib } = recorder(mic.backend);
    await rec.start('nb1', null);
    expect(recLib.lectures('nb1')).toHaveLength(1);
    recLib.removeLecture('s1'); // the delete arrives through the library
    await rec.abandon();
    expect(rec.state).toBe('idle');
    expect(recLib.lectures('nb1')).toHaveLength(0); // no summary written on the way out
    await store.lectureGone(s, lectureDocId('nb1', 'other'));
    expect(lib.lectures()).toHaveLength(0);
  });
});

describe('transcription queue: tries are capped', () => {
  it('a chunk that keeps failing moves to the failed list after a few tries; Retry puts it back', async () => {
    kv.clear();
    const p = { notebookId: 'nb', sessionId: 's9', sha: 'x', mime: 'audio/aac', t0: 0, dur: 1000, lang: 'en' };
    await queueChunk('u1', p);
    for (let i = 0; i < MAX_ASR_ATTEMPTS; i++) await drainQueue('u1', async () => 'retry');
    expect(await pendingChunks('u1')).toEqual([]);
    expect(await failedChunks('u1')).toEqual([{ ...p, attempts: MAX_ASR_ATTEMPTS }]);
    expect(await retryFailed('u1', 's9')).toBe(1);
    expect(await pendingChunks('u1')).toEqual([{ ...p, attempts: 0 }]);
    // A quota error isn't retried at all.
    await drainQueue('u1', async () => 'failed');
    expect((await failedChunks('u1')).map((x) => x.attempts)).toEqual([1]);
  });

  it('stops when the account changes (the rest stays queued)', async () => {
    kv.clear();
    for (const sha of ['a', 'b', 'c']) await queueChunk('u1', { notebookId: 'nb', sessionId: 's', sha, mime: 'audio/aac', t0: 0, dur: 1, lang: '' });
    let n = 0;
    await drainQueue('u1', async () => (n++, 'done'), () => n < 1);
    expect(n).toBe(1);
    expect((await pendingChunks('u1')).map((x) => x.sha)).toEqual(['b', 'c']);
  });
});

describe('lecture audio uploads name their session', () => {
  it('sends X-Qalm-Lecture; a 410 (deleted) is dropped, not retried; dropPending removes a deleted session’s', async () => {
    kv.clear();
    const sent: { sha: string; lecture: string | null }[] = [];
    let status = 201;
    const tm = {
      fetch: async (path: string, init?: RequestInit) => {
        sent.push({ sha: path.split('/').pop()!, lecture: new Headers(init?.headers).get('x-qalm-lecture') });
        return new Response('{}', { status });
      },
    };
    const assets = new AssetService(() => tm as never);
    status = 410;
    const a = await assets.putUnchecked(new Uint8Array(10).fill(1), 'audio/aac', 'x', {}, { lecture: 'lec:nb:s1' });
    await assets.uploadPending();
    expect(sent.at(-1)).toEqual({ sha: a.sha256, lecture: 'lec:nb:s1' });
    expect(kv.get('assets:pending')).toEqual([]);
    // Offline uploads of a session that is then deleted: dropped from the queue before they go.
    tm.fetch = async () => {
      throw new Error('offline');
    };
    const b = await assets.putUnchecked(new Uint8Array(12).fill(2), 'audio/aac', 'y', {}, { lecture: 'lec:nb:s2' });
    await assets.uploadPending();
    expect((kv.get('assets:pending') as { sha: string }[]).map((x) => x.sha)).toEqual([b.sha256]);
    await assets.dropPending([], 'lec:nb:s2');
    expect(kv.get('assets:pending')).toEqual([]);
  });
});
