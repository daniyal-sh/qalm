import { createNotebookDoc, LectureDoc, Library, lectureDocId, unpackQalm, type LectureCrop } from '@qalm/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Review fixes for lecture mode in the app: recorder transitions, playback chunk tracking, the per-account queue,
// leftover sessions, local cleanup, imported crop labels, the streamed export and WAV for the Mac helper.

const kv = new Map<string, unknown>();
vi.mock('../src/lib/kv', () => ({
  kvGet: async (k: string) => (kv.has(k) ? JSON.parse(JSON.stringify(kv.get(k))) : undefined),
  kvSet: async (k: string, v: unknown) => void (v === undefined ? kv.delete(k) : kv.set(k, v)),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Alert: { alert: () => undefined } }));
vi.mock('qalm-lecture', () => ({ QalmLecture: null }));
vi.mock('../src/lib/desktop', () => ({ desktop: () => null }));
const local: string[] = [];
const removed: string[] = [];
vi.mock('../src/sync/persistence', () => ({
  listLocalDocs: async () => [...local],
  removeLocalDoc: async (d: string) => void removed.push(d),
  openPersistence: () => null,
}));
const saved: { name: string; parts: Uint8Array[]; streamed: boolean }[] = [];
vi.mock('../src/export/save', () => ({
  saveFile: async (name: string, _m: string, bytes: Uint8Array) => void saved.push({ name, parts: [bytes], streamed: false }),
  saveFileStream: async (name: string, _m: string, write: (out: (p: Uint8Array) => Promise<void>) => Promise<void>) => {
    const parts: Uint8Array[] = [];
    await write(async (p) => void parts.push(p));
    saved.push({ name, parts, streamed: true });
  },
}));
vi.mock('../src/export/toPng', () => ({ toPng: async () => null }));
const docs = new Map<string, Y.Doc>();
vi.mock('../src/sync/docs', async (orig) => ({
  ...(await orig<typeof import('../src/sync/docs')>()),
  openLoaded: async (_dm: unknown, id: string) => {
    if (!docs.has(id)) docs.set(id, new Y.Doc());
    return { doc: docs.get(id)!, release: () => undefined };
  },
}));

const { LectureRecorder, stopLeftover } = await import('../src/lecture/recorder');
const { LecturePlayback } = await import('../src/lecture/playback');
const { queueChunk, drainQueue, dropQueuedSession, clearQueue, pendingChunks } = await import('../src/lecture/transcribe');
const { accountDocIds } = await import('../src/account/deletion');
const { markImportedCrop } = await import('../src/lecture/imported');
const { deleteForever, exportNotebook } = await import('../src/library/ops');
const { encodeWav } = await import('../src/lecture/wav');
type AudioBackend = import('../src/lecture/audio.types').AudioBackend;
type ChunkPlayer = import('../src/lecture/player.types').ChunkPlayer;

beforeEach(() => vi.useFakeTimers({ now: 1_764_000_000_000 }));
afterEach(() => vi.useRealTimers());
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A mic whose start and stop take time (like a real one), logging what it does. */
function slowAudio(log: string[], ms = 500): AudioBackend {
  let started = 0;
  let open = false;
  return {
    permission: async () => true,
    open: async () => ({
      start: () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            if (open) log.push('START TWICE');
            open = true;
            started = Date.now();
            log.push('start');
            r();
          }, ms),
        ),
      stop: () =>
        new Promise((r, j) =>
          setTimeout(() => {
            if (!open) return j(new Error('stopped twice'));
            open = false;
            log.push('stop');
            r({ bytes: new Uint8Array([1, 2]), mime: 'audio/webm', durMs: Date.now() - started });
          }, ms),
        ),
      release: async () => void log.push('release'),
    }),
  };
}

function recorder(log: string[], errors: unknown[] = []) {
  const docsR = new Map<string, Y.Doc>();
  const rec = new LectureRecorder({
    openDoc: async (id) => {
      if (!docsR.has(id)) docsR.set(id, new Y.Doc());
      return { doc: docsR.get(id)!, release: () => undefined };
    },
    library: () => null,
    audio: slowAudio(log),
    putAudio: async () => 'a'.repeat(64),
    transcriber: 'none',
    newId: () => 's1',
    chunkMs: 60_000,
    onError: (e) => errors.push(e),
  });
  return { rec, lec: () => new LectureDoc(docsR.get(lectureDocId('nb1', 's1'))!) };
}

describe('recorder transitions (pausing / resuming, one mic chain)', () => {
  it('a pause during a chunk rotation never stops the mic twice; resume during pausing is a no-op', async () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const { rec, lec } = recorder(log, errors);
    const started = rec.start('nb1', null);
    await later(600);
    await started;
    await later(60_000 - 600); // the rotation fires now: its stop takes 500 ms
    await later(100);
    const p = rec.pause();
    expect(rec.state).toBe('pausing');
    expect(rec.penLocked).toBe(true);
    void rec.resume(); // too early: ignored
    expect(rec.state).toBe('pausing');
    await later(3000);
    await p;
    expect(rec.state).toBe('paused');
    const r = rec.resume();
    expect(rec.state).toBe('resuming');
    expect(rec.penLocked).toBe(true);
    await later(600);
    await r;
    expect(rec.state).toBe('recording');
    expect(rec.penLocked).toBe(false);
    // Stop right after a pause, without waiting: stop waits for the pause, then ends cleanly.
    void rec.pause();
    const s = rec.stop();
    await later(3000);
    await s;
    expect(rec.state).toBe('idle');
    expect(errors).toEqual([]);
    expect(log.filter((x) => x === 'START TWICE')).toEqual([]);
    // Every start is followed by exactly one stop.
    expect(log).toEqual(['start', 'stop', 'start', 'stop', 'release']);
    expect(lec().events().map((e) => e.k)).toEqual(['start', 'pause', 'resume', 'pause', 'stop']);
  });

  it('stops a session this device left live (crash, closed tab) at its last event', () => {
    const lec = new LectureDoc(new Y.Doc());
    lec.setMeta({ id: 's9', notebookId: 'nb1', startedAt: 1, state: 'recording', transcriber: 'none' });
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }, { t: 4200, k: 'add', p: 'pg', items: [] }]);
    const lib = new Library(new Y.Doc());
    expect(stopLeftover(lec, lib)).toBe(true);
    expect(lec.meta()).toMatchObject({ state: 'stopped', durationMs: 4200 });
    expect(lec.events().at(-1)).toMatchObject({ k: 'stop', t: 4200 });
    expect(lib.lectures('nb1')[0]).toMatchObject({ id: 's9', state: 'stopped' });
    expect(stopLeftover(lec, lib)).toBe(false);
  });
});

describe('playback: the chunk in the player, and seeks', () => {
  /** A player that loads, and applies seeks, a little late (as real ones do). */
  function latePlayer(): ChunkPlayer {
    let pos = 0;
    let at = 0;
    let playing = false;
    const cur = () => (playing ? pos + (Date.now() - at) / 1000 : pos);
    return {
      load: () => new Promise((r) => setTimeout(() => ((pos = 0), r()), 300)),
      play: () => void ((at = Date.now()), (playing = true)),
      pause: () => void ((pos = cur()), (playing = false)),
      seek: (sec) => void setTimeout(() => ((pos = sec), (at = Date.now())), 200),
      setRate: () => undefined,
      position: cur,
      ended: () => false,
      release: () => undefined,
    };
  }

  async function twoChunks() {
    const id = lectureDocId('nb1', 'p1');
    const lec = new LectureDoc(new Y.Doc());
    lec.setMeta({ id: 'p1', notebookId: 'nb1', startedAt: 1, state: 'stopped', durationMs: 240_000, transcriber: 'none' });
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }]);
    lec.addAudio({ sha: 'a', mime: 'audio/webm', t0: 0, dur: 120_000, bytes: 1 });
    lec.addAudio({ sha: 'b', mime: 'audio/webm', t0: 120_000, dur: 120_000, bytes: 1 });
    const pb = new LecturePlayback({
      openDoc: async (d) => ({ doc: d === id ? lec.doc : new Y.Doc(), release: () => undefined }),
      pageItems: async () => [],
      audioUri: (c) => new Promise((r) => setTimeout(() => r(`blob:${c.sha}`), 1000)), // a slow download
      player: latePlayer,
    });
    await pb.load('nb1', 'p1');
    return pb;
  }

  it('crossing into a chunk that is still loading runs on the clock: no jump, no chunk skipped', async () => {
    const pb = await twoChunks();
    const s = pb.seek(118_000);
    await later(1500);
    await s;
    const p = pb.play();
    await later(100);
    await p;
    await later(4000); // through the 120 s boundary while chunk b downloads (1 s) and loads
    expect(pb.t).toBeGreaterThan(121_000);
    expect(pb.t).toBeLessThan(123_500);
    pb.close();
  });

  it('a seek back within the playing chunk sticks (the late player position does not undo it)', async () => {
    const pb = await twoChunks();
    const p = pb.play();
    await later(1500);
    await p;
    await later(10_000);
    expect(pb.t).toBeGreaterThan(9_000);
    await pb.seek(3000);
    await later(1000);
    expect(pb.t).toBeGreaterThanOrEqual(3_500);
    expect(pb.t).toBeLessThan(4_500);
    pb.close();
  });
});

describe('cloud transcription queue: per account', () => {
  const chunk = (sessionId: string, sha: string) => ({ notebookId: 'nb', sessionId, sha, mime: 'audio/webm', t0: 0, dur: 1000, lang: 'en' });

  it('never sends one account’s audio as another; a deleted session’s chunks go; sign-out clears it', async () => {
    kv.clear();
    await queueChunk('A', chunk('s1', 'x'));
    await queueChunk('A', chunk('s2', 'y'));
    const seenB: string[] = [];
    await drainQueue('B', async (p) => (seenB.push(p.sha), true));
    expect(seenB).toEqual([]);
    await dropQueuedSession('A', 's2');
    expect((await pendingChunks('A')).map((p) => p.sha)).toEqual(['x']);
    const seenA: string[] = [];
    await drainQueue('A', async (p) => (seenA.push(p.sha), false)); // offline: kept
    expect(seenA).toEqual(['x']);
    expect(await pendingChunks('A')).toHaveLength(1);
    await clearQueue('A');
    expect(await pendingChunks('A')).toEqual([]);
  });
});

describe('local cleanup and imports', () => {
  it('account deletion forgets the account’s lecture docs too', () => {
    expect(accountDocIds(['lec:a:s1', 'lec:keep:s2', 'nb:a', 'lib:u1'], 'u1', ['a', 'keep'], ['keep']).sort()).toEqual(['lec:a:s1', 'lib:u1', 'nb:a']);
  });

  it('delete forever removes the notebook’s local lecture docs and its sessions from the library', async () => {
    const lib = new Library(new Y.Doc());
    lib.putEntry({ id: 'nb1', title: 'x', cover: '#000', folderId: null, updatedAt: 1, aiAccess: false, favorite: false, deletedAt: null });
    lib.putLecture({ id: 's1', notebookId: 'nb1', startedAt: 1, durationMs: 1, state: 'stopped' });
    lib.putLecture({ id: 'o1', notebookId: 'nb2', startedAt: 1, durationMs: 1, state: 'stopped' });
    local.splice(0, local.length, 'lec:nb1:s1', 'lec:nb1:orphan', 'lec:nb2:o1');
    removed.length = 0;
    const dropped: string[] = [];
    await deleteForever({ dm: { drop: async (id: string) => void dropped.push(id) } as never, assets: {} as never, library: lib, server: null }, 'nb1');
    expect(removed).toEqual(expect.arrayContaining(['lec:nb1:s1', 'lec:nb1:orphan']));
    expect(removed).not.toContain('lec:nb2:o1');
    expect(dropped).toEqual(expect.arrayContaining(['lec:nb1:s1', 'lec:nb1:orphan']));
    expect(lib.lectures().map((l) => l.id)).toEqual(['o1']);
  });

  it('imported crops keep their labels only as the original’s: R7 → (R7 orig)', () => {
    const c: LectureCrop = { t: 1, sha: '', w: 1, h: 1, text: '#q s=x r=1 p1 1000x1415\nR7 [1] p1 @1,2 3x4 +1\nR12 [2] p1 @5,6 7x8', regions: [{ label: 'R7', page: 1, box: [1, 2, 3, 4], add: 1, erase: 0 }] };
    const m = markImportedCrop(c);
    expect(m.regions[0]!.label).toBe('(R7 orig)');
    expect(m.text.split('\n').slice(1)).toEqual(['(R7 orig) [1] p1 @1,2 3x4 +1', '(R12 orig) [2] p1 @5,6 7x8']);
  });
});

describe('export with recordings: streamed', () => {
  it('writes the .qalm in parts; the plain backup stays one buffer', async () => {
    docs.clear();
    saved.length = 0;
    docs.set('nb:nb1', createNotebookDoc({ id: 'nb1', title: 'Calc', cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } }));
    const lec = new LectureDoc(new Y.Doc());
    lec.setMeta({ id: 's1', notebookId: 'nb1', startedAt: 1, state: 'stopped', durationMs: 1000, transcriber: 'none' });
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }]);
    lec.addAudio({ sha: 'a'.repeat(64), mime: 'audio/webm', t0: 0, dur: 1000, bytes: 3 });
    docs.set(lectureDocId('nb1', 's1'), lec.doc);
    const ctx = { dm: {} as never, assets: { bytes: async () => new Uint8Array() } as never };
    await exportNotebook(ctx, 'nb1', 'qalm');
    await exportNotebook(ctx, 'nb1', 'qalm', { lectures: ['s1'], assetBytes: async () => new Uint8Array([7, 7, 7]) });
    expect(saved.map((s) => s.streamed)).toEqual([false, true]);
    const parts = saved[1]!.parts;
    expect(parts.length).toBeGreaterThan(1);
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
    expect(unpackQalm(all).lectures![0]!.audio[0]!.bytes).toEqual(new Uint8Array([7, 7, 7]));
  });
});

describe('WAV for the Mac speech helper', () => {
  it('encodes 16-bit mono PCM with a correct header', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16_000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(40, true)).toBe(8);
    expect(wav.length).toBe(52);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 32767, -32768]);
  });
});

describe('recorder in the background', () => {
  it('doesn’t stop and restart the mic while backgrounded; the chunk rotates once the app is back', async () => {
    const log: string[] = [];
    let background = false;
    const docsR = new Map<string, Y.Doc>();
    const rec = new LectureRecorder({
      openDoc: async (id) => {
        if (!docsR.has(id)) docsR.set(id, new Y.Doc());
        return { doc: docsR.get(id)!, release: () => undefined };
      },
      library: () => null,
      audio: slowAudio(log, 10),
      putAudio: async () => 'a'.repeat(64),
      transcriber: 'none',
      newId: () => 's1',
      chunkMs: 60_000,
      isBackground: () => background,
    });
    const started = rec.start('nb1', null);
    await later(20);
    await started;
    background = true;
    await later(5 * 60_000); // five chunk lengths in the background: still one chunk
    expect(log).toEqual(['start']);
    background = false;
    await later(31_000); // back: the next check rotates
    expect(log).toEqual(['start', 'stop', 'start']);
    const s = rec.stop();
    await later(100);
    await s;
    const audio = new LectureDoc(docsR.get(lectureDocId('nb1', 's1'))!).audio();
    expect(audio[0]!.dur).toBeGreaterThan(5 * 60_000); // the long background chunk is one file
  });
});

describe('AI sharing while a lecture records in the background (owner decision)', () => {
  it('backgrounding during a recording keeps AI live; pausing or stopping the recording in the background stops it', async () => {
    const { AiLive } = await import('../src/editor/aiLive');
    const { holdAiWhileRecording } = await import('../src/lecture/aiHold');
    const sent: string[] = [];
    let toApp: (m: string) => void = () => undefined;
    const live = new AiLive(
      { status: 'synced', sendText: (m) => (sent.push(m), true), onText: (cb) => ((toApp = cb), () => undefined), onStatus: () => () => undefined },
      { everyMs: 15_000, ttlMs: 40_000 },
    );
    const log: string[] = [];
    const { rec } = recorder(log);
    const unbind = holdAiWhileRecording(rec, (r) => live.holdWhileBackgrounded(r));

    live.play();
    toApp('ai:playing:0');
    const started = rec.start('nb1', null);
    await later(600);
    await started;
    live.background(); // another app in front, screen off
    await later(60_000);
    expect(live.playing).toBe(true);
    expect(sent.filter((m) => m === 'ai:live').length).toBeGreaterThanOrEqual(4);
    expect(sent).not.toContain('ai:stop');

    // Pausing the recording while still in the background releases the hold: sharing stops.
    const p = rec.pause();
    await later(1000);
    await p;
    expect(live.playing).toBe(false);
    expect(sent.at(-1)).toBe('ai:stop');

    // Back in front, Play again, resume; then background and stop the recording there: sharing stops too.
    live.foreground();
    live.play();
    toApp('ai:playing:0');
    const r = rec.resume();
    await later(600);
    await r;
    live.background();
    await later(20_000);
    expect(live.playing).toBe(true);
    const s = rec.stop();
    await later(2000);
    await s;
    expect(rec.state).toBe('idle');
    expect(live.playing).toBe(false);
    expect(sent.at(-1)).toBe('ai:stop');
    unbind();
    live.destroy();
  });
});
