import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  LOCAL_ORIGIN,
  LectureClock,
  LectureDoc,
  LectureLog,
  LectureReplay,
  Library,
  createUndoManager,
  encodeLectureRead,
  eventsFromJsonl,
  eventsToJsonl,
  fmtT,
  lectureBundleOf,
  lectureDocFromBundle,
  lectureFiles,
  readLectureFiles,
  packQalm,
  packQalmStream,
  parseCropRegions,
  parseLectureRef,
  parseT,
  splitStroke,
  strokeTimes,
  transcriptLine,
  unpackQalm,
  type LectureEvent,
  type StrokeItem,
} from '../src';
import { newNotebook, newPage, stroke } from './helpers';

afterEach(() => vi.useRealTimers());

/** A session on one page with a fake clock: returns the page, the log's events, the clock setter and the undo manager. */
function session() {
  let now = 0;
  const clock = new LectureClock(() => now);
  clock.start();
  const events: LectureEvent[] = [];
  const page = newPage();
  page.addItem(stroke('old', 10, 10, 50, 20)); // base ink, written before the session
  const log = new LectureLog(() => clock.t(), (e) => events.push(e));
  const undo = createUndoManager(page);
  const detach = log.attach('pg1', page);
  return { page, events, clock, undo, detach, log, at: (t: number) => (now = t) };
}

describe('LectureClock', () => {
  it('runs only while recording', () => {
    let now = 1000;
    const c = new LectureClock(() => now);
    expect(c.t()).toBe(0);
    c.start();
    now = 4000;
    expect(c.t()).toBe(3000);
    expect(c.pause()).toBe(3000);
    now = 60_000;
    expect(c.t()).toBe(3000);
    c.start();
    now = 61_000;
    expect(c.t()).toBe(4000);
  });
});

describe('timeline JSONL', () => {
  it('round-trips events, erased points included, compactly', () => {
    const s = stroke('a', 0, 0, 100, 50);
    const events: LectureEvent[] = [
      { t: 0, k: 'start', at: 1764000000000 },
      { t: 10, k: 'add', p: 'pg1', items: [s] },
      { t: 20, k: 'erase', p: 'pg1', items: [s], by: 'undo' },
      { t: 30, k: 'pause' },
    ];
    const text = eventsToJsonl(events);
    expect(text.split('\n')).toHaveLength(5);
    expect(text).toContain('"points":[[0,0,0.5,1.571,0,0],');
    const back = eventsFromJsonl(`${text}{torn\n`);
    expect(back).toHaveLength(4);
    const erased = back[2] as Extract<LectureEvent, { k: 'erase' }>;
    expect((erased.items[0] as StrokeItem).points).toHaveLength(s.points.length);
    expect((erased.items[0] as StrokeItem).points[5]!.x).toBeCloseTo(s.points[5]!.x, 2);
    expect(erased.by).toBe('undo');
  });

  it('formats and parses times', () => {
    expect(fmtT(0)).toBe('00:00');
    expect(fmtT(192_400)).toBe('03:12');
    expect(fmtT(3_725_000)).toBe('1:02:05');
    expect(parseT('10:00')).toBe(600_000);
    expect(parseT('1:02:05')).toBe(3_725_000);
    expect(parseT('90')).toBe(90_000);
    expect(parseT('x')).toBeNull();
    expect(parseLectureRef('l2@10:00')).toEqual({ label: 'L2', from: 600_000 });
    expect(parseLectureRef('R7')).toBeNull();
  });
});

describe('LectureLog', () => {
  it('logs base ink, adds, erases (with points), moves and undo/redo', () => {
    const { page, events, undo, at } = session();
    expect(events[0]).toMatchObject({ k: 'base', p: 'pg1', ids: ['old'], t: 0 });
    at(5000);
    page.addItem(stroke('a', 100, 100, 200, 120));
    at(9000);
    page.removeItems(['a']);
    at(9500);
    undo.undo(); // the erase is undone: 'a' comes back
    at(12_000);
    page.updateItem('old', { bbox: [20, 20, 60, 30] }); // a move of base ink carries its earlier copy
    at(13_000);
    undo.undo();
    undo.redo();
    const kinds = events.map((e) => `${e.k}@${e.t}${'by' in e && e.by ? `:${e.by}` : ''}`);
    expect(kinds).toEqual(['base@0', 'add@5000', 'erase@9000', 'add@9500:undo', 'update@12000', 'update@13000:undo', 'update@13000:redo']);
    const erase = events[2] as Extract<LectureEvent, { k: 'erase' }>;
    expect((erase.items[0] as StrokeItem).points.length).toBeGreaterThan(5);
    const move = events[4] as Extract<LectureEvent, { k: 'update' }>;
    expect(move.before?.[0]?.id).toBe('old');
    expect((events[5] as Extract<LectureEvent, { k: 'update' }>).before).toBeUndefined();
  });

  it('ignores remote changes and never writes to the page doc', () => {
    const { page, events, detach } = session();
    const before = Y.encodeStateVector(page.doc);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(page.doc));
    other.transact(() => other.getMap('items').delete('old'), 'remote');
    Y.applyUpdate(page.doc, Y.encodeStateAsUpdate(other, before), 'remote');
    expect(events.map((e) => e.k)).toEqual(['base']);
    detach();
    page.addItem(stroke('b', 0, 0, 5, 5));
    expect(events).toHaveLength(1);
  });

  it('logs nothing while disabled (paused, pen locked)', () => {
    const { page, events, log } = session();
    log.setEnabled(false);
    page.addItem(stroke('b', 0, 0, 5, 5));
    log.setEnabled(true);
    page.removeItems(['b']);
    expect(events.map((e) => e.k)).toEqual(['base', 'erase']);
  });
});

describe('LectureReplay', () => {
  it('replays ink as written: erased strokes come back before their erase time', () => {
    const { page, events, at, undo, detach } = session();
    at(1000);
    page.addItem(stroke('a', 100, 100, 200, 120));
    at(2000);
    page.addItem(stroke('b', 100, 200, 200, 220));
    at(3000);
    page.removeItems(['a', 'old']);
    at(4000);
    undo.undo();
    detach();
    page.addItem(stroke('c', 0, 300, 10, 310)); // after the session: replay must not show it
    const r = new LectureReplay(events, (p, id) => (p === 'pg1' ? page.item(id) : undefined));
    const ids = (t: number) => r.at(t).get('pg1')!.map((i) => i.id).sort();
    expect(ids(0)).toEqual(['old']);
    expect(ids(1500)).toEqual(['a', 'old']);
    expect(ids(2500)).toEqual(['a', 'b', 'old']);
    expect(ids(3500)).toEqual(['b']);
    expect(ids(4000)).toEqual(['a', 'b', 'old']);
    expect(ids(500)).toEqual(['old']); // seeking back
    expect(r.at(500).get('pg1')).toBe(r.at(500).get('pg1')); // stable while unchanged
    const times = strokeTimes(events);
    expect(times.get('a')).toBe(1000 - 80); // the stroke's own 80 ms
    expect(times.has('old')).toBe(false);
  });

  it('uses the erased copy of base ink that is gone from the page now', () => {
    const { page, events, at } = session();
    at(1000);
    page.removeItems(['old']);
    const r = new LectureReplay(events, (_p, id) => page.item(id));
    expect(r.at(0).get('pg1')!.map((i) => i.id)).toEqual(['old']);
    expect(r.at(1000).get('pg1')).toEqual([]);
  });
});

describe('LectureDoc', () => {
  it('appends chunks and keeps meta, audio, transcript and crops', () => {
    const lec = new LectureDoc(new Y.Doc());
    lec.setMeta({ id: 's1', notebookId: 'nb1', startedAt: 1, state: 'recording', transcriber: 'cloud' });
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }, { t: 500, k: 'page', p: 'pg1', n: 1 }]);
    lec.appendEvents([{ t: 400, k: 'base', p: 'pg1', ids: [] }]);
    expect(lec.events().map((e) => e.t)).toEqual([0, 400, 500]);
    expect(lec.meta()).toMatchObject({ lastT: 500, durationMs: 500, state: 'recording', transcriber: 'cloud' });
    lec.addAudio({ sha: 'a'.repeat(64), mime: 'audio/webm', t0: 0, dur: 120_000, bytes: 480_000 });
    lec.addTranscript([{ t0: 1000, t1: 2000, text: 'hello' }]);
    lec.addCrop({ t: 500, sha: 'b'.repeat(64), w: 10, h: 10, text: '', regions: [] });
    expect(lec.assetShas()).toHaveLength(2);
    expect(lec.transcriptFrom(0).segs).toHaveLength(1);
  });

  it('lists sessions in the library, not in notebook docs', () => {
    const lib = new Library(new Y.Doc());
    lib.putLecture({ id: 's1', notebookId: 'nb1', startedAt: 1, durationMs: 5, state: 'stopped' });
    lib.putLecture({ id: 's2', notebookId: 'nb2', startedAt: 2, durationMs: 5, state: 'stopped' });
    expect(lib.lectures('nb1').map((s) => s.id)).toEqual(['s1']);
    expect(lib.lectures().map((s) => s.id)).toEqual(['s2', 's1']);
    lib.removeLecture('s1');
    expect(lib.lectures('nb1')).toEqual([]);
  });
});

describe('MCP lecture text', () => {
  it('formats live transcript lines and an interleaved read', () => {
    expect(transcriptLine('L2', { t0: 192_000, t1: 195_000, text: ' so the derivative ' })).toBe('L2 03:12 "so the derivative"');
    const crops = [{ t: 195_000, sha: 'c1', w: 1, h: 1, text: 'R40 [1] p2 @120,300 260x80 +5', regions: parseCropRegions('#q s=x r=1 p2 1000x1415\nR40 [1] p2 @120,300 260x80 +5 (was R3)') }];
    expect(crops[0]!.regions).toEqual([{ label: 'R40', row: 1, page: 2, box: [120, 300, 260, 80], add: 5, erase: 0 }]);
    const meta = { id: 's', notebookId: 'n', startedAt: 0, durationMs: 900_000, state: 'stopped' as const, lastT: 0, transcriber: 'cloud' as const };
    const parts = encodeLectureRead('L2', meta, [{ t0: 192_000, t1: 194_000, text: 'so the derivative' }, { t0: 700_000, t1: 701_000, text: 'later' }], crops);
    expect(parts).toEqual([
      { text: '#q L2 00:00-10:00 of 15:00 stopped\n03:12 "so the derivative"\n03:15 R40 [1] p2 @120,300 260x80 +5' },
      { image: 'c1' },
      { text: 'more: read("L2@10:00")' },
    ]);
    expect(encodeLectureRead('L2', meta, [{ t0: 700_000, t1: 701_000, text: 'later' }], crops, 600_000)).toEqual([{ text: '#q L2 10:00-15:00 of 15:00 stopped\n11:40 "later"' }]);
  });
});

/** packQalm as it was before lecture mode, to prove a plain export didn't change. */
function packQalmBefore(b: { index: Y.Doc; pages: Map<string, Y.Doc>; assets: Map<string, Uint8Array> }): Uint8Array {
  const files: Zippable = { 'index.bin': Y.encodeStateAsUpdate(b.index) };
  for (const [id, doc] of b.pages) files[`pages/${id}.bin`] = Y.encodeStateAsUpdate(doc);
  for (const [id, bytes] of b.assets) files[`assets/${id}`] = [bytes, { level: 0 }];
  return zipSync(files);
}

describe('.qalm with lectures', () => {
  function recorded() {
    const nb = newNotebook();
    const pageId = nb.pages()[0]!.id;
    const { page, events, at } = session();
    at(2000);
    page.addItem(stroke('a', 100, 100, 200, 120));
    at(4000);
    page.removeItems(['a']);
    const lec = new LectureDoc(new Y.Doc());
    lec.setMeta({ id: 's1', notebookId: 'nb1', startedAt: 1764000000000, state: 'stopped', transcriber: 'device' });
    lec.appendEvents([{ t: 0, k: 'start', at: 1764000000000 }, ...events.map((e) => ('p' in e ? { ...e, p: pageId } : e)) as LectureEvent[], { t: 5000, k: 'stop' }]);
    const audio = new Uint8Array([1, 2, 3, 4]);
    const png = new Uint8Array([137, 80, 78, 71]);
    lec.addAudio({ sha: 'a'.repeat(64), mime: 'audio/webm;codecs=opus', t0: 0, dur: 5000, bytes: 4 });
    lec.addCrop({ t: 2000, sha: 'b'.repeat(64), w: 4, h: 4, text: 'R1 [1] p1 @1,2 3x4 +1', regions: parseCropRegions('R1 [1] p1 @1,2 3x4 +1') });
    lec.addTranscript([{ t0: 100, t1: 900, text: 'today: integrals', src: 'device' }]);
    const pages = new Map([[pageId, page.doc]]);
    const bundle = lectureBundleOf(lec, 's1', (id) => (id === pageId ? 1 : 0));
    bundle.audio[0]!.bytes = audio;
    bundle.crops[0]!.png = png;
    return { nb, pageId, pages, bundle, audio, png };
  }

  it('off: exactly the plain backup, nothing from sessions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const { nb, pages } = recorded();
    const assets = new Map([['png1', new Uint8Array([9, 9, 9])]]);
    const now = packQalm({ index: nb.doc, pages, assets });
    expect(now).toEqual(packQalmBefore({ index: nb.doc, pages, assets }));
    const names = Object.keys(unzipSync(now));
    expect(names.some((n) => n.startsWith('lecture/'))).toBe(false);
    expect(unpackQalm(now).lectures).toBeUndefined();
    // Sessions never reach the index doc either: the notebook's maps are the usual ones.
    expect([...nb.doc.share.keys()].some((k) => /lect/i.test(k))).toBe(false);
  });

  it('on: a lecture/ folder per session that round-trips', () => {
    const { nb, pageId, pages, bundle, audio, png } = recorded();
    const bytes = packQalm({ index: nb.doc, pages, assets: new Map(), lectures: [bundle] });
    const files = unzipSync(bytes);
    const names = Object.keys(files).filter((n) => n.startsWith('lecture/')).sort();
    expect(names).toEqual([
      'lecture/s1/LECTURE.md',
      'lecture/s1/audio/000-0.webm',
      'lecture/s1/crops/000-2000.json',
      'lecture/s1/crops/000-2000.png',
      'lecture/s1/session.json',
      'lecture/s1/timeline.jsonl',
      'lecture/s1/transcript.json',
    ]);
    const md = strFromU8(files['lecture/s1/LECTURE.md']!);
    expect(md).toContain('timeline.jsonl');
    const jsonl = strFromU8(files['lecture/s1/timeline.jsonl']!);
    expect(jsonl.split('\n').filter((l) => l.includes('"k":"erase"'))[0]).toContain('"points":[[');

    const back = unpackQalm(bytes);
    expect(back.pages.size).toBe(1);
    const l = back.lectures![0]!;
    expect(l.meta).toMatchObject({ id: 's1', durationMs: 5000, transcriber: 'device', state: 'stopped' });
    expect(l.events.map((e) => e.k)).toEqual(['start', 'base', 'add', 'erase', 'stop']);
    expect(l.audio[0]!.bytes).toEqual(audio);
    expect(l.audio[0]!.chunk).toMatchObject({ mime: 'audio/webm;codecs=opus', t0: 0, dur: 5000 });
    expect(l.crops[0]!.png).toEqual(png);
    expect(l.crops[0]!.crop.regions[0]!.label).toBe('R1');
    expect(l.transcript).toEqual([{ t0: 100, t1: 900, text: 'today: integrals' }]);

    // Restore into a new notebook: new ids, page ids mapped.
    const doc = lectureDocFromBundle(l, { sessionId: 's9', notebookId: 'nb9', pageIds: new Map([[pageId, 'newpg']]), audioShas: ['c'.repeat(64)], cropShas: ['d'.repeat(64)] });
    const lec = new LectureDoc(doc);
    expect(lec.meta()).toMatchObject({ id: 's9', notebookId: 'nb9', state: 'stopped', durationMs: 5000 });
    expect(lec.events().filter((e) => 'p' in e).every((e) => (e as { p: string }).p === 'newpg')).toBe(true);
    expect(lec.audio()[0]!.sha).toBe('c'.repeat(64));
    expect(lec.crops()[0]!.sha).toBe('d'.repeat(64));
  });

  it('streamed: the same files, written in parts, one session at a time', async () => {
    const { nb, pages, bundle } = recorded();
    const assets = new Map([['img1', new Uint8Array([7, 7, 7])]]);
    const pulled: string[] = [];
    async function* sessions() {
      for (const id of ['s1', 's2']) {
        pulled.push(`session ${id}`);
        yield { ...bundle, id, meta: { ...bundle.meta, id } };
      }
    }
    const parts: Uint8Array[] = [];
    await packQalmStream({ index: nb.doc, pages, assets }, sessions(), (p) => {
      parts.push(p);
      pulled.push('part');
    });
    // Parts went out before the second session was even read.
    expect(pulled.indexOf('part')).toBeLessThan(pulled.indexOf('session s2'));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
    const streamed = unzipSync(all);
    const whole = unzipSync(packQalm({ index: nb.doc, pages, assets, lectures: [bundle, { ...bundle, id: 's2', meta: { ...bundle.meta, id: 's2' } }] }));
    expect(Object.keys(streamed).sort()).toEqual(Object.keys(whole).sort());
    for (const k of Object.keys(whole)) expect(streamed[k]).toEqual(whole[k]);
    expect(unpackQalm(all).lectures!.map((l) => l.id).sort()).toEqual(['s1', 's2']);
  });

  it('skips a broken session instead of failing the import', () => {
    const { nb, pages } = recorded();
    const plain = unzipSync(packQalm({ index: nb.doc, pages, assets: new Map() }));
    plain['lecture/bad/session.json'] = strToU8('{not json');
    const back = unpackQalm(zipSync(plain));
    expect(back.lectures).toBeUndefined();
    expect(back.pages.size).toBe(1);
  });

  it('a page edit during recording only touches the page doc it always did', () => {
    const { page, events } = session();
    const lec = new LectureDoc(new Y.Doc());
    lec.appendEvents(events);
    page.doc.transact(() => page.doc.getMap('items'), LOCAL_ORIGIN);
    expect([...page.doc.share.keys()].some((k) => /lect|timeline|audio/i.test(k))).toBe(false);
  });
});

describe('lecture review fixes', () => {
  const meta = { id: 's1', notebookId: 'nb', startedAt: 1, durationMs: 60_000, state: 'stopped' as const, lastT: 60_000, transcriber: 'none' as const };

  it('more: is exact and always moves forward, even with many crops in one second (or one ms)', () => {
    const crops = Array.from({ length: 12 }, (_, i) => ({ t: 5000 + i * 10, sha: `c${i}`, w: 1, h: 1, text: '', regions: [] }));
    let from = 0;
    const seen: string[] = [];
    for (let n = 0; n < 5; n++) {
      const parts = encodeLectureRead('L1', meta, [], crops, from);
      seen.push(...parts.flatMap((p) => ('image' in p ? [p.image] : [])));
      const more = /more: read\("L1@(.+)"\)/.exec(parts.map((p) => ('text' in p ? p.text : '')).join('\n'));
      if (!more) break;
      const ref = parseLectureRef(`L1@${more[1]}`)!;
      expect(ref.from).toBeGreaterThan(from);
      from = ref.from;
    }
    expect(new Set(seen).size).toBe(12);
    expect(parseT('03:12.25')).toBe(192_250);
    expect(parseT('7.5')).toBe(7500);
    // Twelve crops in the very same ms: the pointer still advances past that ms.
    const same = crops.map((c) => ({ ...c, t: 5000 }));
    const text = encodeLectureRead('L1', meta, [], same, 5000).map((p) => ('text' in p ? p.text : '')).join('\n');
    expect(text).toContain('more: read("L1@00:05.001")');
  });

  it('imports a corrupt session without breaking reads: bad transcript, crops and events are dropped', () => {
    const files: Zippable = {
      'lecture/abc/session.json': strToU8(JSON.stringify({ id: '', startedAt: 'x', durationMs: 9000, pages: [{ id: 'p' }, 'junk', { id: 'pg', n: 1 }], audio: 'nope', title: 7 })),
      'lecture/abc/transcript.json': strToU8(JSON.stringify([{ t0: 1000, t1: 2000, text: 'ok' }, { t0: 'a', text: 'bad time' }, { t0: 3000, text: 42 }, null, 'x', { t0: 4000, text: 'words', words: [{ w: 1 }, { w: 'w', t0: 4000, t1: 4100 }] }])),
      'lecture/abc/crops/000-1000.json': strToU8(JSON.stringify({ t: 1000, text: 5, regions: [{ label: 'R1', page: 1, box: [1, 2, 3, 4] }, { label: 'R2', box: 'x' }] })),
      'lecture/abc/crops/001-2000.json': strToU8('{broken'),
      'lecture/abc/crops/002-3000.json': strToU8(JSON.stringify({ t: 'later' })),
      'lecture/abc/timeline.jsonl': strToU8(
        ['{"t":0,"k":"start","at":1}', '{"t":5,"k":"add","p":"pg","items":"no"}', '{"t":6,"k":"add","p":"pg","items":[{"id":"a","type":"stroke","points":[]}, 3]}', '{"t":7,"k":"bogus"}', '{"t":-1,"k":"stop"}', '[1,2]'].join('\n'),
      ),
    };
    const [b] = readLectureFiles(unzipSync(zipSync(files)));
    expect(b!.id).toBe('abc');
    expect(b!.meta).toMatchObject({ id: 'abc', startedAt: 0, durationMs: 9000 });
    expect(b!.meta.title).toBeUndefined();
    expect(b!.pages).toEqual([{ id: 'pg', n: 1 }]);
    expect(b!.transcript).toEqual([{ t0: 1000, t1: 2000, text: 'ok' }, { t0: 4000, t1: 4000, text: 'words', words: [{ w: 'w', t0: 4000, t1: 4100 }] }]);
    expect(b!.crops.map((c) => c.crop)).toEqual([{ t: 1000, sha: '', w: 0, h: 0, text: '', regions: [{ label: 'R1', page: 1, box: [1, 2, 3, 4], add: 0, erase: 0 }] }]);
    expect(b!.events.map((e) => e.k)).toEqual(['start', 'add']);
    expect((b!.events[1] as { items: unknown[] }).items).toHaveLength(1);
    // Restored and read like MCP would: no throw.
    const lec = new LectureDoc(lectureDocFromBundle(b!, { sessionId: 'n1', notebookId: 'nb', pageIds: new Map([['pg', 'pg2']]), audioShas: [], cropShas: ['s'] }));
    expect(() => encodeLectureRead('L1', lec.meta(), lec.transcript(), lec.crops())).not.toThrow();
  });

  it('a session doc with garbage written into it still reads (transcript, crops, live lines)', () => {
    const lec = new LectureDoc(new Y.Doc());
    const raw = lec.doc.getArray<unknown>('transcript');
    raw.push([{ t0: 1, t1: 2, text: 'fine' }, { bad: true }, { t0: 3, t1: 4, text: 'also' }]);
    lec.doc.getArray<unknown>('crops').push([{ t: 'no' }, { t: 5, sha: 'x', regions: 'no' }]);
    expect(lec.transcript().map((s) => s.text)).toEqual(['fine', 'also']);
    expect(lec.crops()).toEqual([{ t: 5, sha: 'x', w: 0, h: 0, text: '', regions: [] }]);
    // next counts the malformed one too, so a live reader moves past it; max caps a batch.
    expect(lec.transcriptFrom(0, 2)).toEqual({ segs: [{ t0: 1, t1: 2, text: 'fine' }], next: 2 });
    expect(lec.transcriptFrom(2)).toEqual({ segs: [{ t0: 3, t1: 4, text: 'also' }], next: 3 });
  });

  it('the export folder is the session id passed in, never meta.id', () => {
    const lec = new LectureDoc(new Y.Doc()); // meta never set: meta.id is ''
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }]);
    const b = lectureBundleOf(lec, 'sess-9', () => 0);
    expect(Object.keys(lectureFiles(b)).every((n) => n.startsWith('lecture/sess-9/'))).toBe(true);
    expect(() => lectureFiles({ ...b, id: '' })).toThrow();
    expect(() => lectureFiles({ ...b, id: '../x' })).toThrow();
  });
});

describe('lecture × partial erase (#68)', () => {
  it('replays a partial erase in place and seeks a piece to its stroke’s write time', () => {
    const { page, events, at } = session();
    at(1000);
    page.addItem(stroke('a', 100, 100, 300, 120));
    at(2000);
    page.addItem(stroke('b', 100, 200, 300, 220));
    at(3000);
    page.addItem(stroke('c', 100, 300, 300, 320));
    // Erase through the middle of 'a': one transaction replaces it by its two pieces (the eraser commits at pen-up).
    at(8000);
    const a = page.item('a') as StrokeItem;
    const pieces = splitStroke(a, [{ x: 200, y: 90 }, { x: 200, y: 130 }], 6, (() => {
      let n = 0;
      return () => `a${++n}`;
    })())!;
    expect(pieces.length).toBe(2);
    expect(pieces.every((p) => p.splitFrom === 'a')).toBe(true);
    page.applyErase({ split: [{ id: 'a', pieces }], remove: [] });
    const kinds = events.map((e) => `${e.k}@${e.t}`);
    expect(kinds.slice(-2).sort()).toEqual(['add@8000', 'erase@8000']); // one erase + one add, at the same time

    const replay = new LectureReplay(events, (_p, id) => page.item(id) ?? undefined);
    const ids = (t: number) => (replay.at(t).get('pg1') ?? []).map((i) => i.id);
    expect(ids(5000)).toEqual(['old', 'a', 'b', 'c']);
    // The pieces stand where 'a' stood (under 'b' and 'c'), not on top of everything.
    expect(ids(9000)).toEqual(['old', 'a1', 'a2', 'b', 'c']);
    expect(ids(5000)).toEqual(['old', 'a', 'b', 'c']); // seeking back brings 'a' whole again

    // Tap-to-seek: a piece seeks to when 'a' was written, not to the erase. A piece of a piece too.
    const times = strokeTimes(events);
    expect(times.get('a1')).toBe(times.get('a'));
    expect(times.get('a2')).toBe(times.get('a'));
    at(9000);
    const a1 = page.item('a1') as StrokeItem;
    const sub = splitStroke(a1, [{ x: 140, y: 90 }, { x: 140, y: 130 }], 4, (() => {
      let n = 0;
      return () => `a1-${++n}`;
    })())!;
    page.applyErase({ split: [{ id: 'a1', pieces: sub }], remove: [] });
    const again = strokeTimes(events);
    for (const p of sub) expect(again.get(p.id)).toBe(times.get('a'));
  });
});
