import { createNotebookDoc, LectureDoc, Library, lectureDocId, Notebook, Page, unpackQalm, type StrokeItem } from '@qalm/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { buildQalm, restoreQalm, type NotebookSource } from '../src/export/notebookExport';
import type { AudioBackend, ChunkRecorder, RecordedChunk } from '../src/lecture/audio.types';
import { LecturePlayback } from '../src/lecture/playback';
import type { ChunkPlayer } from '../src/lecture/player.types';
import { LectureRecorder } from '../src/lecture/recorder';
import { docIds } from '../src/sync/docs';
import { stroke } from './helpers';

beforeEach(() => vi.useFakeTimers({ now: 1_764_000_000_000 }));
afterEach(() => vi.useRealTimers());

/** A microphone that records `bytes` of silence per chunk and remembers what it did. */
function fakeAudio(log: string[]): AudioBackend {
  let n = 0;
  let started = 0;
  const rec: ChunkRecorder = {
    async start() {
      log.push('start');
      started = Date.now();
    },
    async stop(): Promise<RecordedChunk> {
      log.push('stop');
      return { bytes: new Uint8Array([n++, 1, 2, 3]), mime: 'audio/webm', durMs: Date.now() - started };
    },
    async release() {
      log.push('release');
    },
  };
  return { permission: async () => true, open: async () => rec };
}

function setup(opts: { transcribe?: boolean } = {}) {
  const docs = new Map<string, Y.Doc>();
  const lib = new Library(new Y.Doc());
  const audioLog: string[] = [];
  const put: { mime: string; bytes: number }[] = [];
  let ids = 0;
  const rec = new LectureRecorder({
    openDoc: async (id) => {
      if (!docs.has(id)) docs.set(id, new Y.Doc());
      return { doc: docs.get(id)!, release: () => undefined };
    },
    library: () => lib,
    audio: fakeAudio(audioLog),
    putAudio: async (bytes, mime) => {
      put.push({ mime, bytes: bytes.length });
      return `${put.length}`.padStart(64, 'a');
    },
    transcriber: opts.transcribe ? 'cloud' : 'none',
    transcribe: opts.transcribe ? async (c) => [{ t0: 100, t1: 900, text: `chunk at ${c.t0}` }] : undefined,
    newId: () => `s${++ids}`,
    chunkMs: 60_000,
  });
  const page = new Page(new Y.Doc());
  page.addItem(stroke(10, 10, 60, 10)); // ink from before the session
  return { rec, docs, lib, audioLog, put, page };
}

const lecOf = (docs: Map<string, Y.Doc>, sid: string) => new LectureDoc(docs.get(lectureDocId('nb1', sid))!);
const later = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('LectureRecorder', () => {
  it('records a session: audio chunks, every stroke event, pause locks the pen, one timeline', async () => {
    const { rec, docs, lib, audioLog, put, page } = setup({ transcribe: true });
    rec.attachPage('pg1', page);
    const sid = await rec.start('nb1', { id: 'pg1', n: 1 });
    expect(rec.state).toBe('recording');
    expect(lib.lectures('nb1')[0]).toMatchObject({ id: sid, state: 'recording' });

    await later(5000);
    const a = stroke(100, 100, 200, 120);
    page.addItem(a);
    await later(3000);
    page.removeItems([a.id]);
    await later(2000);

    // Pause: audio stops, the pen locks, the clock freezes.
    await rec.pause();
    expect(rec.penLocked).toBe(true);
    expect(rec.t()).toBe(10_000);
    await later(60_000);
    expect(rec.t()).toBe(10_000);
    page.addItem(stroke(0, 300, 10, 310)); // can't happen in the app (tool 'none'); never logged anyway
    await rec.resume();
    expect(rec.penLocked).toBe(false);
    await later(4000);
    page.addItem(stroke(300, 300, 400, 320));
    // A chunk is rotated every chunkMs while recording.
    await later(60_000);
    await rec.stop();
    expect(rec.state).toBe('idle');

    const lec = lecOf(docs, sid);
    const kinds = lec.events().map((e) => `${e.k}@${e.t}`);
    expect(kinds).toEqual(['start@0', 'base@0', 'page@0', 'add@5000', 'erase@8000', 'pause@10000', 'resume@10000', 'add@14000', 'stop@74000']);
    const erase = lec.events().find((e) => e.k === 'erase') as { items: StrokeItem[] };
    expect(erase.items[0]!.points.length).toBe(a.points.length);
    expect(lec.meta()).toMatchObject({ state: 'stopped', durationMs: 74_000, transcriber: 'cloud' });
    // Chunks: [0, 10 s) before the pause, [10 s, 70 s) rotated, [70 s, 74 s) at stop; each its own file.
    expect(lec.audio().map((c) => [c.t0, c.dur])).toEqual([
      [0, 10_000],
      [10_000, 60_000],
      [70_000, 4_000],
    ]);
    expect(put).toHaveLength(3);
    expect(audioLog).toEqual(['start', 'stop', 'start', 'stop', 'start', 'stop', 'release']);
    // Transcript segments shifted onto the timeline.
    expect(lec.transcript().map((s) => [s.t0, s.text])).toEqual([
      [100, 'chunk at 0'],
      [10_100, 'chunk at 10000'],
      [70_100, 'chunk at 70000'],
    ]);
    expect(lib.lectures('nb1')[0]).toMatchObject({ state: 'stopped', durationMs: 74_000 });
    // The page doc holds only ink: nothing from the session.
    expect([...page.doc.share.keys()].some((k) => /lect|timeline|audio/.test(k))).toBe(false);
  });

  it('refuses to start without the microphone, and logs nothing then', async () => {
    const { rec, docs } = setup();
    (rec as unknown as { deps: { audio: AudioBackend } }).deps.audio = { permission: async () => false, open: async () => ({}) as ChunkRecorder };
    await expect(rec.start('nb1', null)).rejects.toThrow(/microphone/);
    expect(rec.state).toBe('idle');
    expect(docs.size).toBe(0);
  });

  it('flushes the timeline about a second after a stroke', async () => {
    const { rec, docs, page } = setup();
    rec.attachPage('pg1', page);
    const sid = await rec.start('nb1', { id: 'pg1', n: 1 });
    const n0 = lecOf(docs, sid).timelineChunks().length;
    page.addItem(stroke(100, 100, 200, 120));
    expect(lecOf(docs, sid).timelineChunks().length).toBe(n0);
    await later(1100);
    expect(lecOf(docs, sid).timelineChunks().length).toBe(n0 + 1);
    expect(lecOf(docs, sid).meta().lastT).toBe(0);
    await rec.stop();
  });
});

/** A player whose clock is the fake timers. */
function fakePlayer(): ChunkPlayer & { loads: string[] } {
  let pos = 0;
  let playing = false;
  let at = 0;
  let rate = 1;
  const loads: string[] = [];
  const cur = () => (playing ? pos + ((Date.now() - at) / 1000) * rate : pos);
  return {
    loads,
    async load(uri) {
      loads.push(uri);
      pos = 0;
    },
    play() {
      at = Date.now();
      playing = true;
    },
    pause() {
      pos = cur();
      playing = false;
    },
    seek(sec) {
      pos = sec;
      at = Date.now();
    },
    setRate(r) {
      pos = cur();
      at = Date.now();
      rate = r;
    },
    position: cur,
    ended: () => false,
    release() {},
  };
}

describe('LecturePlayback', () => {
  async function recorded() {
    const s = setup();
    s.rec.attachPage('pg1', s.page);
    const sid = await s.rec.start('nb1', { id: 'pg1', n: 1 });
    await later(2000);
    s.page.addItem({ ...stroke(100, 100, 200, 120), id: 'late' });
    await later(2000);
    s.page.removeItems(['late']);
    await later(2000);
    await s.rec.stop();
    const player = fakePlayer();
    const pb = new LecturePlayback({
      openDoc: async (id) => ({ doc: s.docs.get(id)!, release: () => undefined }),
      pageItems: async () => s.page.items(),
      audioUri: async (c) => `blob:${c.t0}`,
      player: () => player,
    });
    await pb.load('nb1', sid);
    return { pb, player, page: s.page };
  }

  it('replays ink as written and follows the audio, at 1×, 1.5× and 2×', async () => {
    const { pb, player } = await recorded();
    expect(pb.duration).toBe(6000);
    const ids = () => (pb.items().get('pg1') ?? []).map((i) => i.id);
    expect(ids()).toHaveLength(1); // the base ink
    await pb.play();
    expect(player.loads).toEqual(['blob:0']);
    await later(2500);
    expect(pb.t).toBeGreaterThanOrEqual(2400);
    expect(ids()).toContain('late');
    await later(1600);
    expect(ids()).not.toContain('late'); // erased at 4 s
    pb.pause();
    await pb.seek(2100);
    expect(ids()).toContain('late'); // it comes back when seeking before its erase
    pb.setRate(2);
    await pb.play();
    await later(1000);
    expect(pb.t).toBeGreaterThanOrEqual(4000);
    await later(2000);
    expect(pb.playing).toBe(false);
    expect(pb.t).toBe(6000);
    pb.close();
  });

  it('jumps to when a tapped stroke was written', async () => {
    const { pb } = await recorded();
    await pb.seek(3000);
    const t = await pb.tapAt('pg1', 150, 110, 6);
    expect(t).toBe(2000 - 160); // the stroke's own 160 ms
    expect(pb.t).toBe(1840);
    expect(await pb.tapAt('pg1', 500, 700, 6)).toBeNull();
  });
});

describe('lecture .qalm export and import', () => {
  it('includes sessions only when asked, and restores them into the new notebook', async () => {
    const s = setup();
    const nb = new Notebook(createNotebookDoc({ id: 'nb1', title: 'Calc', cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } }));
    const pageId = nb.pages()[0]!.id;
    s.rec.attachPage(pageId, s.page);
    const sid = await s.rec.start('nb1', { id: pageId, n: 1 });
    await later(1000);
    s.page.addItem(stroke(100, 100, 200, 120));
    await later(1000);
    await s.rec.stop();
    const src: NotebookSource = { notebook: nb, loadPage: async () => ({ doc: s.page.doc, release: () => undefined }), assetBytes: async () => new Uint8Array() };

    const plain = unpackQalm(await buildQalm(src));
    expect(plain.lectures).toBeUndefined();

    const { lectureBundleOf } = await import('@qalm/core');
    const bundle = lectureBundleOf(lecOf(s.docs, sid), sid, () => 1);
    bundle.audio[0]!.bytes = new Uint8Array([7, 7, 7]);
    const bytes = await buildQalm(src, [bundle]);
    expect(unpackQalm(bytes).lectures).toHaveLength(1);

    const written = new Map<string, Uint8Array>();
    const restored: { sessions: number; pages: Map<string, string>; nb: string }[] = [];
    const meta = await restoreQalm(
      bytes,
      async (id, u) => void written.set(id, u),
      async () => undefined,
      (() => {
        let n = 0;
        return () => `new${++n}`;
      })(),
      async (sessions, pages, notebookId) => void restored.push({ sessions: sessions.length, pages, nb: notebookId }),
    );
    expect(restored).toEqual([{ sessions: 1, pages: new Map([[pageId, 'new2']]), nb: meta.id }]);
    expect(written.has(docIds.notebook(meta.id))).toBe(true);
    // Without a restorer (signed out, or an older app) the sessions are skipped and the notebook still restores.
    const meta2 = await restoreQalm(bytes, async () => undefined, async () => undefined, () => 'x' + Math.random());
    expect(meta2.title).toBe('Calc (restored)');
  });
});
