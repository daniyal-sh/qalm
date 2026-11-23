import * as Y from 'yjs';
import { itemBBox, unionBBox } from '../geometry/bbox';
import { decodePoints } from '../points';
import type { BBox, Item } from '../types';

/** Origin of the one-time migration from lines: not undoable, not a student edit. */
export const MIGRATION_ORIGIN = 'qalm.migrate';

/** Whether a page doc still holds data from before regions (lines, items' `line` fields, line-anchored comments). */
export function needsMigration(doc: Y.Doc): boolean {
  if (doc.getMap('lines').size) return true;
  for (const m of doc.getMap<Y.Map<unknown>>('items').values()) if (m.has('line')) return true;
  for (const m of doc.getMap<Y.Map<unknown>>('comments').values()) if (m.has('lineKey')) return true;
  return false;
}

/**
 * Moves a page doc from lines to regions, once (idempotent: a migrated page has nothing left to move, and every write
 * is deterministic, so two devices migrating the same page at once converge):
 * - a comment on a line (`lineKey`) is anchored to that line's strokes (`anchorIds`, with their box as `anchor`);
 * - a line's text saved by the student or an agent becomes a reading of its strokes (id `m:{lineKey}`);
 *   on-device guesses are dropped;
 * - the `lines` map and items' `line` fields are removed.
 * Returns whether anything changed.
 */
export function migratePage(doc: Y.Doc): boolean {
  if (!needsMigration(doc)) return false;
  const items = doc.getMap<Y.Map<unknown>>('items');
  const lines = doc.getMap<Y.Map<unknown>>('lines');
  const comments = doc.getMap<Y.Map<unknown>>('comments');
  const readings = doc.getMap<Y.Map<unknown>>('readings');
  doc.transact(() => {
    // Each line's strokes, in z-order.
    const groups = new Map<string, string[]>();
    for (const id of doc.getArray<string>('order').toArray()) {
      const key = items.get(id)?.get('line');
      if (typeof key !== 'string') continue;
      const g = groups.get(key) ?? [];
      if (!g.includes(id)) g.push(id);
      groups.set(key, g);
    }
    const boxOf = (ids: string[]): BBox | null => {
      let bb: BBox | null = null;
      for (const id of ids) {
        const m = items.get(id);
        if (!m) continue;
        const o: Record<string, unknown> = {};
        m.forEach((v, k) => (o[k] = k === 'points' && v instanceof Uint8Array ? decodePoints(v) : v));
        bb = unionBBox(bb, itemBBox(o as unknown as Item));
      }
      return bb;
    };
    comments.forEach((m) => {
      if (!m.has('lineKey')) return;
      const key = m.get('lineKey');
      const has = Array.isArray(m.get('anchorIds')) && (m.get('anchorIds') as unknown[]).length > 0;
      if (!has && typeof key === 'string' && key) {
        const ids = groups.get(key) ?? [];
        if (ids.length) m.set('anchorIds', ids);
        if (!m.has('anchor')) {
          const bb = boxOf(ids);
          if (bb) m.set('anchor', bb);
        }
      }
      m.delete('lineKey');
    });
    lines.forEach((e, key) => {
      const text = e.get('text');
      const src = e.get('textSrc');
      const ids = groups.get(key) ?? [];
      if (typeof text !== 'string' || !text || (src !== 'agent' && src !== 'user') || !ids.length) return;
      const id = `m:${key}`;
      if (readings.has(id)) return;
      const m = new Y.Map<unknown>();
      readings.set(id, m);
      m.set('id', id);
      m.set('ids', ids);
      m.set('text', text);
      m.set('src', src);
      const by = e.get('by');
      if (typeof by === 'string') m.set('by', by);
      m.set('updatedAt', 0);
    });
    for (const key of [...lines.keys()]) lines.delete(key);
    items.forEach((m) => {
      if (m.has('line')) m.delete('line');
    });
  }, MIGRATION_ORIGIN);
  return true;
}
