import { LOCAL_ORIGIN, Page, createUndoManager, moveBy, transformPatch, type ImageItem, type TextItem } from '@qalm/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { getClip, pasteItems, PASTE_STEP, persistClip, setClip } from '../src/editor/clipboard';
import { hitText, recolorPatch, selectionBBox } from '../src/editor/items';
import { liveFrame } from '../src/editor/selection.logic';
import { stroke } from './helpers';

let n = 0;
const fresh = () => `n${++n}`;

describe('clipboard', () => {
  it('pastes in place on another page and stepped on its own page, always with fresh ids', () => {
    const s = stroke(10, 10, 30, 10);
    setClip([s], [], 'p1');
    const c = getClip()!;
    const other = pasteItems(c, 'p2', fresh);
    expect(other[0]!.id).not.toBe(s.id);
    expect(other[0]!.type === 'stroke' && other[0]!.bbox).toEqual(s.bbox);
    const a = pasteItems(c, 'p1', fresh)[0]!;
    const b = pasteItems(c, 'p1', fresh)[0]!;
    expect(a.type === 'stroke' && a.bbox[0]).toBeCloseTo(s.bbox[0] + PASTE_STEP);
    expect(b.type === 'stroke' && b.bbox[0]).toBeCloseTo(s.bbox[0] + 2 * PASTE_STEP);
  });

  it('keeps its own copy, so later edits to the source do not change what is pasted', () => {
    const t: TextItem = { id: 't', type: 'text', x: 0, y: 0, w: 100, text: 'a', fontSize: 16, color: '#000' };
    setClip([t], [], 'p1');
    t.text = 'changed';
    expect((getClip()!.items[0] as TextItem).text).toBe('a');
  });

  it('is saved on copy and paste, and a saved clip comes back after a restart', async () => {
    let saved: unknown;
    const store = { get: async () => saved, set: async (c: unknown) => void (saved = JSON.parse(JSON.stringify(c))) };
    // Something was copied in this run already: the saved clip doesn't replace it.
    saved = { items: [stroke(0, 0, 1, 1)], assets: [], pageId: 'old', pastes: 0 };
    await persistClip(store);
    expect(getClip()!.pageId).not.toBe('old');

    const img: ImageItem = { id: 'im', type: 'image', assetId: 'a1', x: 0, y: 0, w: 10, h: 10 };
    const asset = { id: 'a1', sha256: 'h', mime: 'image/png', name: 'a.png', bytes: 3 };
    setClip([img], [asset], 'p1');
    expect(saved).toMatchObject({ items: [img], assets: [asset], pageId: 'p1', pastes: 0 });
    pasteItems(getClip()!, 'p1', fresh);
    expect(saved).toMatchObject({ pastes: 1 });

    // A fresh module (the app restarted) restores it.
    vi.resetModules();
    const fresh2 = await import('../src/editor/clipboard');
    expect(fresh2.getClip()).toBeNull();
    await fresh2.persistClip(store);
    expect(fresh2.getClip()).toEqual({ items: [img], assets: [asset], pageId: 'p1', pastes: 1 });
    const next = fresh2.pasteItems(fresh2.getClip()!, 'p1', fresh)[0] as ImageItem;
    expect(next.x).toBe(2 * PASTE_STEP);

    // Junk in storage is ignored.
    vi.resetModules();
    const fresh3 = await import('../src/editor/clipboard');
    await fresh3.persistClip({ get: async () => ({ items: 'x' }), set: async () => undefined });
    expect(fresh3.getClip()).toBeNull();
    await fresh3.persistClip({ get: async () => { throw new Error('io'); }, set: async () => undefined });
    expect(fresh3.getClip()).toBeNull();
  });
});

describe('selection helpers', () => {
  it('recolours ink and text, never images or highlighters', () => {
    expect(recolorPatch(stroke(0, 0, 1, 1), '#f00')).toEqual({ color: '#f00' });
    expect(recolorPatch(stroke(0, 0, 1, 1, { tool: 'highlighter' }), '#f00')).toBeNull();
    expect(recolorPatch({ id: 'i', type: 'image', assetId: 'a', x: 0, y: 0, w: 1, h: 1 }, '#f00')).toBeNull();
  });

  it('the Ask / Comment box covers the ink, including its width', () => {
    const s = stroke(10, 10, 30, 10);
    const box = selectionBBox([s])!;
    expect(box[0]).toBeLessThan(s.bbox[0]);
    expect(box[3]).toBeGreaterThan(s.bbox[3]);
  });

  it('finds turned text boxes for the text tool', () => {
    const t: TextItem = { id: 't', type: 'text', x: 100, y: 100, w: 100, text: 'a', fontSize: 16, color: '#000', rot: Math.PI / 2 };
    expect(hitText([t], 90, 150)?.id).toBe('t');
    expect(hitText([t], 150, 110)).toBeNull();
  });

  it('the live frame follows a move or a text box width change', () => {
    const img: ImageItem = { id: 'i', type: 'image', assetId: 'a', x: 0, y: 0, w: 100, h: 50 };
    expect(liveFrame([img], { kind: 'sim', sim: moveBy(10, 0) })).toMatchObject({ cx: 60, cy: 25, w: 100, h: 50 });
    const t: TextItem = { id: 't', type: 'text', x: 0, y: 0, w: 100, text: 'hello', fontSize: 16, color: '#000' };
    expect(liveFrame([t], { kind: 'text', id: 't', patch: { x: 0, y: 0, w: 200 } })!.w).toBe(200);
  });

  it('a move is one undo step and syncs to another device', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
    const pa = new Page(a);
    const pb = new Page(b);
    const s1 = stroke(10, 100, 30, 110);
    const s2 = stroke(40, 100, 60, 110);
    pa.addItem(s1);
    pa.addItem(s2);
    const um = createUndoManager(pa);
    a.transact(() => {
      for (const s of [s1, s2]) pa.updateItem(s.id, transformPatch(pa.item(s.id)!, moveBy(0, 300)));
    }, LOCAL_ORIGIN);
    const moved = pb.item(s1.id);
    expect(moved?.type === 'stroke' && moved.bbox[1]).toBeCloseTo(s1.bbox[1] + 300);
    expect(pb.lines().map((l) => l.itemIds)).toEqual([[s1.id, s2.id]]);
    um.undo();
    const back = pb.item(s1.id);
    expect(back?.type === 'stroke' && back.bbox[1]).toBeCloseTo(s1.bbox[1]);
  });
});
