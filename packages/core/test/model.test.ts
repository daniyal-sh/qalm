import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Library, LOCAL_ORIGIN, Page, createUndoManager, decodePoints, encodePoints } from '../src';
import type { ShapeItem, StrokeItem } from '../src';
import { newNotebook, newPage, pts, stroke, sync } from './helpers';

describe('points codec', () => {
  it('round-trips Float32 6-tuples', () => {
    const p = [
      { x: 10.5, y: 20.25, p: 0.3, tilt: 1.2, az: 2.5, t: 0 },
      { x: 595, y: 842, p: 1, tilt: Math.PI / 2, az: -1, t: 1234 },
    ];
    const bytes = encodePoints(p);
    expect(bytes.byteLength).toBe(2 * 6 * 4);
    const back = decodePoints(bytes);
    expect(back).toHaveLength(2);
    back.forEach((q, i) => {
      for (const k of ['x', 'y', 'p', 'tilt', 'az', 't'] as const) expect(q[k]).toBeCloseTo(p[i]![k], 5);
    });
  });

  it('decodes from an unaligned view', () => {
    const bytes = encodePoints([{ x: 1, y: 2, p: 0.5, tilt: 1, az: 0, t: 3 }]);
    const buf = new Uint8Array(bytes.length + 1);
    buf.set(bytes, 1);
    expect(decodePoints(buf.subarray(1))[0]!.t).toBe(3);
  });

  it('is what the page doc stores', () => {
    const page = newPage();
    page.addItem(stroke('s1', 0, 0, 10, 10));
    const raw = page.doc.getMap<Y.Map<unknown>>('items').get('s1')!.get('points');
    expect(raw).toBeInstanceOf(Uint8Array);
    const item = page.items()[0]!;
    expect(item.type === 'stroke' && item.points.length).toBe(11);
  });
});

describe('Notebook', () => {
  it('starts with one page and manages pages, assets and asks', () => {
    const nb = newNotebook();
    expect(nb.meta()).toMatchObject({ id: 'nb1', title: 'Calculus', orientation: 'portrait', aiAccess: false });
    const [first] = nb.pages();
    expect(nb.pages()).toHaveLength(1);
    expect(first).toMatchObject({ size: { w: 595, h: 842 }, paper: 'ruled', paperColor: 'white', background: { kind: 'paper' } });
    const b = nb.addPage({ paper: 'grid' });
    const c = nb.addPage({}, 0);
    expect(nb.pages().map((p) => p.id)).toEqual([c, first!.id, b]);
    nb.movePage(c, 2);
    expect(nb.pages().map((p) => p.id)).toEqual([first!.id, b, c]);
    nb.removePage(b);
    expect(nb.pages().map((p) => p.id)).toEqual([first!.id, c]);
    nb.setMeta({ title: 'Calc II' });
    expect(nb.meta().title).toBe('Calc II');
    nb.addAsset({ id: 'a1', sha256: 'ff', mime: 'application/pdf', name: 'hw.pdf', bytes: 10, pageCount: 2 });
    expect(nb.assets()).toHaveLength(1);
    nb.addAsk(c, 'help?');
    expect(nb.asks()).toMatchObject([{ pageId: c, text: 'help?' }]);
  });

  it('observe fires for local and remote changes', () => {
    const nb = newNotebook();
    let n = 0;
    const off = nb.observe(() => n++);
    nb.setMeta({ title: 'x' });
    off();
    nb.setMeta({ title: 'y' });
    expect(n).toBe(1);
  });
});

describe('Library', () => {
  it('does folder and entry CRUD', () => {
    const lib = new Library(new Y.Doc());
    const f = lib.addFolder('Math');
    lib.putEntry({ id: 'nb1', title: 'Calc', cover: '#4338ca', folderId: f, updatedAt: 1, aiAccess: false, favorite: false, deletedAt: null });
    lib.updateEntry('nb1', { favorite: true });
    lib.renameFolder(f, 'Maths');
    expect(lib.folders()).toMatchObject([{ id: f, name: 'Maths' }]);
    expect(lib.entry('nb1')).toMatchObject({ favorite: true, folderId: f });
    lib.removeFolder(f);
    expect(lib.entry('nb1')!.folderId).toBeNull();
    lib.removeEntry('nb1');
    expect(lib.entries()).toEqual([]);
  });
});

describe('line assignment', () => {
  it('groups strokes on the same row and keys a new line by its first stroke', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 65, 102, 80, 121)); // gap 5 <= 1.5 * 20
    page.addItem(stroke('c', 200, 100, 210, 120)); // gap 120: new line
    page.addItem(stroke('d', 50, 150, 70, 170)); // next row
    const lines = page.lines();
    expect(lines.map((l) => [l.key, l.kind, l.itemIds])).toEqual([
      ['a', 'line', ['a', 'b']],
      ['c', 'line', ['c']],
      ['d', 'line', ['d']],
    ]);
    expect(lines[0]!.bbox).toEqual([50, 100, 80, 121]);
  });

  it('requires 50% vertical overlap of the smaller height', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 62, 112, 70, 132)); // overlap 8 < 10
    page.addItem(stroke('c', 40, 109, 48, 129)); // overlap with a's line (100..120): 11 >= 10, gap 2
    expect(page.lines().map((l) => l.itemIds)).toEqual([['a', 'c'], ['b']]);
  });

  it('makes tall strokes and shapes drawings, merging overlapping drawings (earliest key wins)', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 50, 150, 60, 170));
    page.addItem(stroke('t1', 300, 300, 400, 400)); // 100 > 2.5 * 20
    const shape: ShapeItem = { id: 'sh', type: 'shape', kind: 'rect', pts: [[500, 300], [550, 300], [550, 350], [500, 350]], color: '#000', width: 2 };
    page.addItem(shape);
    expect(page.lines().filter((l) => l.kind === 'drawing').map((l) => l.key)).toEqual(['t1', 'sh']);
    page.addItem(stroke('t2', 380, 290, 520, 420)); // overlaps both drawings
    const drawings = page.lines().filter((l) => l.kind === 'drawing');
    expect(drawings).toHaveLength(1);
    expect(drawings[0]!.key).toBe('t1');
    expect(drawings[0]!.itemIds).toEqual(['t1', 'sh', 't2']);
  });

  it('deletes empty lines and clears text on change unless the user wrote it', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('x', 50, 200, 60, 220));
    page.setLineText('a', 'hi', 'device', 0.8);
    page.setLineText('x', 'mine', 'user');
    expect(page.lines()[0]).toMatchObject({ text: 'hi', textSrc: 'device', conf: 0.8 });
    page.addItem(stroke('b', 62, 100, 70, 120));
    page.addItem(stroke('y', 62, 200, 70, 220));
    const [a, x] = page.lines();
    expect(a!.text).toBeUndefined();
    expect(x).toMatchObject({ text: 'mine', textSrc: 'user' });
    page.removeItems(['a', 'b']);
    expect(page.lines().map((l) => l.key)).toEqual(['x']);
    expect(page.doc.getMap('lines').has('a')).toBe(false);
  });

  it('keeps trusted text from device guesses', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.setLineText('a', 'x^2', 'agent');
    page.setLineText('a', 'x2', 'device');
    expect(page.lines()[0]).toMatchObject({ text: 'x^2', textSrc: 'agent' });
  });

  it('keeps the key when a whole line is moved, and splits off moved parts', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 62, 100, 70, 120));
    page.addItem(stroke('c', 72, 100, 80, 120));
    page.addItem(stroke('z', 50, 300, 60, 320));
    page.doc.transact(() => {
      for (const id of ['b', 'a', 'c']) {
        const it = page.item(id)!;
        if (it.type !== 'stroke') continue;
        page.updateItem(id, { bbox: [it.bbox[0], it.bbox[1] + 400, it.bbox[2], it.bbox[3] + 400], points: it.points.map((q) => ({ ...q, y: q.y + 400 })) });
      }
    }, LOCAL_ORIGIN);
    expect(page.lines().map((l) => [l.key, l.itemIds])).toEqual([
      ['a', ['a', 'b', 'c']],
      ['z', ['z']],
    ]);
    page.updateItem('c', { bbox: [72, 300, 80, 320] }); // onto z's row
    expect(page.lines().map((l) => [l.key, l.itemIds])).toEqual([
      ['a', ['a', 'b']],
      ['z', ['c', 'z']],
    ]);
  });

  it('never collides keys when two offline devices add lines, then merge', () => {
    const a = new Y.Doc();
    const pa = new Page(a);
    pa.addItem(stroke('s0', 50, 100, 60, 120));
    const b = new Y.Doc();
    sync(a, b);
    const pb = new Page(b);
    // Offline: both write new lines at the same place, and both extend the shared line.
    pa.addItem(stroke('a1', 50, 150, 60, 170));
    pa.addItem(stroke('a2', 62, 100, 70, 120));
    pb.addItem(stroke('b1', 52, 152, 62, 172));
    pb.addItem(stroke('b2', 62, 101, 72, 121));
    sync(a, b);
    for (const p of [pa, pb]) {
      const lines = p.lines();
      const keys = lines.map((l) => l.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(lines.map((l) => [l.key, [...l.itemIds].sort()]).sort()).toEqual([
        ['a1', ['a1']],
        ['b1', ['b1']],
        ['s0', ['a2', 'b2', 's0']],
      ]);
      expect(lines.flatMap((l) => l.itemIds).sort()).toEqual(['a1', 'a2', 'b1', 'b2', 's0']);
    }
    expect(pa.lines()).toEqual(pb.lines());
  });
});

describe('comments', () => {
  it('adds, replies and resolves', () => {
    const page = newPage();
    const id = page.addComment({ lineKey: 'a', author: { kind: 'agent', name: 'Claude' }, text: 'check L5' });
    page.replyToComment(id, { kind: 'user', name: 'Sam' }, 'thanks');
    page.resolveComment(id);
    expect(page.comments()).toMatchObject([{ id, lineKey: 'a', resolved: true, replies: [{ text: 'thanks' }] }]);
  });
});

describe('undo', () => {
  it('undoes only local changes', () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();
    const page = new Page(local);
    const undo = createUndoManager(page);
    page.addItem(stroke('mine', 50, 100, 60, 120));
    const rp = new Page(remote);
    sync(local, remote);
    rp.addItem(stroke('theirs', 62, 100, 70, 120));
    // Sync before the next local add: concurrent inserts are ordered by random clientID, which made this flaky.
    sync(local, remote);
    page.addItem(stroke('mine2', 50, 200, 60, 220));
    sync(local, remote);
    expect(page.items().map((i) => i.id)).toEqual(['mine', 'theirs', 'mine2']);
    undo.undo();
    expect(page.items().map((i) => i.id)).toEqual(['mine', 'theirs']);
    undo.undo();
    expect(page.items().map((i) => i.id)).toEqual(['theirs']);
    expect(undo.canUndo()).toBe(false);
    expect(page.lines().map((l) => [l.key, l.itemIds])).toEqual([['mine', ['theirs']]]);
    undo.redo();
    expect(page.lines().map((l) => [l.key, l.itemIds])).toEqual([['mine', ['mine', 'theirs']]]);
  });
});

it('pts helper', () => {
  expect(pts([0, 0], [10, 0])).toHaveLength(11);
});

describe('item read cache', () => {
  it('keeps unchanged items (and the list) identical between reads', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 70, 100, 80, 120));
    const first = page.items();
    expect(page.items()).toBe(first);
    page.updateItem('b', { color: '#b91c1c' });
    const next = page.items();
    expect(next).not.toBe(first);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1]!.type === 'stroke' && next[1]!.color).toBe('#b91c1c');
  });

  it('sees writes made earlier in the same transaction', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.doc.transact(() => {
      expect((page.item('a') as StrokeItem).color).toBe('#27272a');
      page.updateItem('a', { color: '#1d4ed8' });
      expect((page.item('a') as StrokeItem).color).toBe('#1d4ed8');
      page.addItem(stroke('b', 70, 100, 80, 120));
      expect(page.items().map((i) => i.id)).toEqual(['a', 'b']);
      page.removeItems(['a']);
      expect(page.items().map((i) => i.id)).toEqual(['b']);
    }, LOCAL_ORIGIN);
  });

  it('drops stale reads on remote changes and undo', () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();
    const page = new Page(local);
    const undo = createUndoManager(page);
    page.addItem(stroke('a', 50, 100, 60, 120));
    sync(local, remote);
    const before = page.items();
    new Page(remote).updateItem('a', { color: '#0f766e' });
    sync(local, remote);
    const it = page.items()[0]!;
    expect(it).not.toBe(before[0]);
    expect(it.type === 'stroke' && it.color).toBe('#0f766e');
    page.updateItem('a', { color: '#b45309' });
    undo.undo();
    const back = page.item('a')!;
    expect(back.type === 'stroke' && back.color).toBe('#0f766e');
  });
});

describe('item read cache and z-order', () => {
  it('sees a reorder made earlier in the same transaction', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 70, 100, 80, 120));
    expect(page.items().map((i) => i.id)).toEqual(['a', 'b']);
    page.doc.transact(() => {
      page.reorder(['a'], 'front');
      expect(page.items().map((i) => i.id)).toEqual(['b', 'a']);
    }, LOCAL_ORIGIN);
    expect(page.items().map((i) => i.id)).toEqual(['b', 'a']);
  });
});
