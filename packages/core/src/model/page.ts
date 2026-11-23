import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { encodePoints, decodePoints } from '../points';
import { itemBBox, unionBBox } from '../geometry/bbox';
import { boxGap, NEAR, pageUnit } from '../geometry/regions';
import { newId } from '../ids';
import type { Author, BBox, Comment, InkPoint, Item, Reading, ReadingSrc } from '../types';

type YItem = Y.Map<unknown>;

const GEOMETRY_KEYS = new Set(['points', 'bbox', 'x', 'y', 'w', 'h', 'pts']);
const isInkType = (t: unknown) => t === 'stroke' || t === 'shape';

/**
 * Ink changes in the current outermost `Page` call, settled against the page's readings when it returns: a reading
 * goes stale when strokes are erased from it or added to it (tech-spec §2, readings).
 */
interface InkChanges {
  /** Each reading's box when the call started (before any change). */
  before: Map<string, BBox | null>;
  /** Ink added or moved: its box before (null if it is new). */
  touched: Map<string, BBox | null>;
  removed: Set<string>;
}

/** How deep each doc is in `Page` calls (ink changes are settled when it returns to 0). */
const depths = new WeakMap<Y.Doc, number>();
const changes = new WeakMap<Y.Doc, InkChanges>();

function readItem(m: YItem): Item {
  const o: Record<string, unknown> = {};
  m.forEach((v, k) => {
    if (k === 'line') return; // left by notebooks from before regions (see migratePage)
    o[k] = k === 'points' && v instanceof Uint8Array ? decodePoints(v) : v;
  });
  return o as unknown as Item;
}

/** Reads only what `itemBBox` needs (no points decoding). */
function readGeometry(m: YItem): Item {
  if (m.get('type') === 'stroke') return { type: 'stroke', bbox: m.get('bbox') } as Item;
  return readItem(m);
}

function setFields(m: YItem, fields: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === 'type' || k === 'line') continue;
    if (v === undefined) m.delete(k);
    else m.set(k, k === 'points' ? encodePoints(v as InkPoint[]) : v);
  }
}

export function readReading(m: Y.Map<unknown>): Reading | null {
  const ids = m.get('ids');
  const text = m.get('text');
  const src = m.get('src');
  if (!Array.isArray(ids) || typeof text !== 'string' || (src !== 'agent' && src !== 'user')) return null;
  const r: Reading = { id: m.get('id') as string, ids: ids.filter((x): x is string => typeof x === 'string'), text, src, updatedAt: Number(m.get('updatedAt')) || 0 };
  const by = m.get('by');
  if (typeof by === 'string') r.by = by;
  if (m.get('stale') === true) r.stale = true;
  return r;
}

/**
 * Wraps one page doc: `items` (by id), `order` (z-order), `comments` (threads) and `readings` (someone's reading of
 * some strokes). There is no line grouping: agents get regions of changed strokes (qink.ts), computed when an update
 * is sent.
 */
export class Page {
  readonly doc: Y.Doc;
  private readonly itemMap: Y.Map<YItem>;
  private readonly order: Y.Array<string>;
  private readonly commentMap: Y.Map<Y.Map<unknown>>;
  private readonly readingMap: Y.Map<Y.Map<unknown>>;
  /**
   * Decoded items by their Y.Map, and the last `items()` array: decoding every stroke's points on each change was the
   * main cost of editing a page with thousands of strokes. Entries are dropped when their map changes (locally in
   * `setFields`, remotely or by undo through `observeDeep`), so unchanged items keep their identity across reads.
   */
  private decoded = new WeakMap<YItem, Item>();
  private list: Item[] | null = null;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.itemMap = doc.getMap('items');
    this.order = doc.getArray('order');
    this.commentMap = doc.getMap('comments');
    this.readingMap = doc.getMap('readings');
    this.itemMap.observeDeep((events) => {
      this.list = null;
      for (const ev of events) if (ev.target !== this.itemMap) this.decoded.delete(ev.target as YItem);
    });
    this.order.observe(() => {
      this.list = null;
    });
  }

  private read(m: YItem): Item {
    let it = this.decoded.get(m);
    if (!it) {
      it = readItem(m);
      this.decoded.set(m, it);
    }
    return it;
  }

  /** Drops cached reads of `m` (a local write inside a transaction, before observers run). */
  private dirty(m?: YItem): void {
    this.list = null;
    if (m) this.decoded.delete(m);
  }

  private tx(fn: () => void): void {
    this.doc.transact(() => {
      const d = depths.get(this.doc) ?? 0;
      depths.set(this.doc, d + 1);
      try {
        fn();
      } finally {
        depths.set(this.doc, d);
        if (d === 0) this.settleReadings();
      }
    }, LOCAL_ORIGIN);
  }

  private orderedIds(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of this.order.toArray()) {
      if (seen.has(id) || !this.itemMap.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /**
   * Items in z-order. The array and its items are cached and shared between calls (same objects until they change):
   * treat them as read-only.
   */
  items(): Item[] {
    this.list ??= this.orderedIds().map((id) => this.read(this.itemMap.get(id)!));
    return this.list;
  }

  item(id: string): Item | undefined {
    const m = this.itemMap.get(id);
    return m ? this.read(m) : undefined;
  }

  private box(id: string): BBox | null {
    const m = this.itemMap.get(id);
    return m ? itemBBox(readGeometry(m)) : null;
  }

  addItem(item: Item): void {
    this.tx(() => {
      const old = this.itemMap.get(item.id);
      if (isInkType(item.type) || (old && isInkType(old.get('type')))) this.noteInk(item.id);
      const m = new Y.Map<unknown>();
      this.dirty();
      this.itemMap.set(item.id, m);
      m.set('id', item.id);
      m.set('type', item.type);
      setFields(m, item as unknown as Record<string, unknown>);
      this.order.push([item.id]);
    });
  }

  /** Adds items in one transaction (one undo step), in order: the same result as `addItem` for each. */
  addItems(items: readonly Item[]): void {
    this.tx(() => {
      for (const it of items) this.addItem(it);
    });
  }

  updateItem(id: string, patch: Partial<Item>): void {
    this.tx(() => {
      const m = this.itemMap.get(id);
      if (!m) return;
      if (isInkType(m.get('type')) && Object.keys(patch).some((k) => GEOMETRY_KEYS.has(k))) this.noteInk(id);
      this.dirty(m);
      setFields(m, patch as Record<string, unknown>);
    });
  }

  /** Updates items in one transaction (one undo step), in order: the same result as `updateItem` for each. */
  updateItems(patches: Iterable<readonly [id: string, patch: Partial<Item>]>): void {
    this.tx(() => {
      for (const [id, patch] of patches) this.updateItem(id, patch);
    });
  }

  /** Moves items to the top (`front`) or bottom (`back`) of the z-order, keeping their order among themselves. */
  reorder(ids: string[], to: 'front' | 'back'): void {
    this.tx(() => {
      const move = new Set(ids.filter((id) => this.itemMap.has(id)));
      if (!move.size) return;
      this.dirty();
      const moved = this.orderedIds().filter((id) => move.has(id));
      const arr = this.order.toArray();
      for (let i = arr.length - 1; i >= 0; i--) if (move.has(arr[i]!)) this.order.delete(i, 1);
      if (to === 'front') this.order.push(moved);
      else this.order.insert(0, moved);
    });
  }

  removeItems(ids: string[]): void {
    this.tx(() => {
      const gone = new Set(ids);
      this.dirty();
      const ch = this.inkChanges();
      for (const id of ids) {
        if (ch && this.itemMap.has(id)) ch.removed.add(id);
        this.itemMap.delete(id);
      }
      // Delete from the end, a run of adjacent slots at a time.
      const arr = this.order.toArray();
      for (let i = arr.length - 1; i >= 0; i--) {
        if (!gone.has(arr[i]!)) continue;
        let j = i;
        while (j > 0 && gone.has(arr[j - 1]!)) j--;
        this.order.delete(j, i - j + 1);
        i = j;
      }
    });
  }

  // ---- readings ----

  readings(): Reading[] {
    const out: Reading[] = [];
    this.readingMap.forEach((m) => {
      const r = readReading(m);
      if (r) out.push(r);
    });
    return out.sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1));
  }

  /**
   * Saves a reading of strokes `ids`. An agent's reading (`src: 'agent'`, `by` its name) is refused (null) when the
   * student's own reading covers any of those strokes; agents can't overwrite the student. Readings of the same or
   * weaker kind whose strokes are all within `ids` are replaced (an agent's by any new one, the student's only by the
   * student's). Returns the new reading's id.
   */
  setReading(ids: readonly string[], text: string, src: ReadingSrc, by?: string): string | null {
    const want = [...new Set(ids)].filter((id) => this.itemMap.has(id));
    if (!want.length) return null;
    const set = new Set(want);
    const all = this.readings();
    if (src === 'agent' && all.some((r) => r.src === 'user' && r.ids.some((id) => set.has(id)))) return null;
    const id = newId();
    this.tx(() => {
      for (const r of all) if ((src === 'user' || r.src === 'agent') && r.ids.every((x) => set.has(x))) this.readingMap.delete(r.id);
      const m = new Y.Map<unknown>();
      this.readingMap.set(id, m);
      m.set('id', id);
      m.set('ids', want);
      m.set('text', text);
      m.set('src', src);
      if (by !== undefined) m.set('by', by);
      m.set('updatedAt', Date.now());
    });
    return id;
  }

  /** The student edits a reading: it becomes theirs (fresh, no agent name). Empty text removes it. */
  editReading(id: string, text: string): void {
    const m = this.readingMap.get(id);
    if (!m) return;
    this.tx(() => {
      if (!text.trim()) {
        this.readingMap.delete(id);
        return;
      }
      m.set('text', text);
      m.set('src', 'user');
      m.delete('by');
      m.delete('stale');
      m.set('updatedAt', Date.now());
    });
  }

  removeReading(id: string): void {
    this.tx(() => this.readingMap.delete(id));
  }

  /** Notes a change of ink item `id` (call before changing it). */
  private noteInk(id: string): void {
    const ch = this.inkChanges();
    if (ch && !ch.touched.has(id)) ch.touched.set(id, this.box(id));
  }

  /** This call's ink changes (none while the page has no readings: nothing can go stale). */
  private inkChanges(): InkChanges | undefined {
    if (!this.readingMap.size) return undefined;
    let ch = changes.get(this.doc);
    if (!ch) {
      ch = { before: new Map(), touched: new Map(), removed: new Set() };
      for (const r of this.readings()) ch.before.set(r.id, this.readingBox(r.ids));
      changes.set(this.doc, ch);
    }
    return ch;
  }

  private readingBox(ids: readonly string[]): BBox | null {
    let bb: BBox | null = null;
    for (const id of ids) {
      const b = this.box(id);
      if (b) bb = unionBBox(bb, b);
    }
    return bb;
  }

  /**
   * At the end of an outermost `Page` call: a reading goes **stale** when any of its strokes was erased, or ink that
   * isn't part of it came within ½ unit of it (written, pasted or moved there; ink that moved along with it doesn't
   * count). A reading whose strokes are all gone is deleted. Moving, resizing or recolouring a read region keeps it.
   */
  private settleReadings(): void {
    const ch = changes.get(this.doc);
    changes.delete(this.doc);
    if (!ch || (!ch.touched.size && !ch.removed.size)) return;
    for (const r of this.readings()) {
      const live = r.ids.filter((id) => this.itemMap.has(id));
      if (!live.length) {
        this.readingMap.delete(r.id);
        continue;
      }
      if (r.stale) continue;
      let stale = r.ids.some((id) => ch.removed.has(id));
      if (!stale && ch.touched.size) {
        const now = this.readingBox(live)!;
        const was = ch.before.get(r.id) ?? null;
        const boxes = live.map((id) => this.box(id)!);
        const near = NEAR * pageUnit(undefined, boxes);
        const mine = new Set(r.ids);
        for (const [id, old] of ch.touched) {
          if (mine.has(id)) continue;
          const b = this.box(id);
          if (!b || boxGap(b, now) > near) continue;
          if (old && was && boxGap(old, was) <= near) continue; // it was next to the reading already (moved together)
          stale = true;
          break;
        }
      }
      if (stale) this.readingMap.get(r.id)!.set('stale', true);
    }
  }

  // ---- comments ----

  comments(): Comment[] {
    const out: Comment[] = [];
    this.commentMap.forEach((m) => {
      const replies = m.get('replies') as Y.Array<Comment['replies'][number]> | undefined;
      const c: Comment = {
        id: m.get('id') as string,
        author: m.get('author') as Author,
        text: m.get('text') as string,
        createdAt: m.get('createdAt') as number,
        resolved: m.get('resolved') === true,
        replies: replies ? replies.toArray() : [],
      };
      const anchor = m.get('anchor');
      if (Array.isArray(anchor) && anchor.length === 4) c.anchor = anchor as BBox;
      const anchorIds = m.get('anchorIds');
      if (Array.isArray(anchorIds) && anchorIds.length) c.anchorIds = anchorIds.filter((x): x is string => typeof x === 'string');
      if (m.get('ask') === true) c.ask = true;
      out.push(c);
    });
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  /** Starts a thread on strokes (`anchorIds`, with `anchor` as their box), on a box only, or on the whole page. */
  addComment(c: Omit<Comment, 'id' | 'createdAt' | 'resolved' | 'replies'>): string {
    const id = newId();
    this.tx(() => {
      const m = new Y.Map<unknown>();
      this.commentMap.set(id, m);
      m.set('id', id);
      m.set('author', c.author);
      m.set('text', c.text);
      m.set('createdAt', Date.now());
      m.set('resolved', false);
      m.set('replies', new Y.Array());
      if (c.anchor) m.set('anchor', [...c.anchor]);
      if (c.anchorIds?.length) m.set('anchorIds', [...c.anchorIds]);
      if (c.ask) m.set('ask', true);
    });
    return id;
  }

  /** Adds a reply. A student's reply reopens a resolved thread. Returns false if the thread is gone. */
  replyToComment(id: string, author: Author, text: string): boolean {
    const m = this.commentMap.get(id);
    const replies = m?.get('replies') as Y.Array<unknown> | undefined;
    if (!m || !replies) return false;
    this.tx(() => {
      replies.push([{ author, text, at: Date.now() }]);
      if (author.kind === 'user' && m.get('resolved') === true) m.set('resolved', false);
    });
    return true;
  }

  resolveComment(id: string): void {
    this.tx(() => this.commentMap.get(id)?.set('resolved', true));
  }

  /**
   * Copies another page's items (with new ids, same z-order) and readings (of the copies) into this one, in one
   * transaction. Comments are not copied (they are threads about the original). Linear in the number of items.
   */
  copyFrom(src: Page, makeId: () => string = newId): void {
    const ids = new Map<string, string>();
    for (const id of src.orderedIds()) ids.set(id, makeId());
    this.tx(() => {
      this.dirty();
      const order: string[] = [];
      for (const [oldId, id] of ids) {
        const from = src.itemMap.get(oldId)!;
        const m = new Y.Map<unknown>();
        this.itemMap.set(id, m);
        from.forEach((v, k) => {
          if (k === 'id') m.set('id', id);
          else if (k === 'line') return;
          else m.set(k, v instanceof Uint8Array ? v.slice() : Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v);
        });
        order.push(id);
      }
      this.order.push(order);
      for (const r of src.readings()) {
        const mapped = r.ids.map((x) => ids.get(x)).filter((x): x is string => !!x);
        if (!mapped.length) continue;
        const rid = newId();
        const m = new Y.Map<unknown>();
        this.readingMap.set(rid, m);
        m.set('id', rid);
        m.set('ids', mapped);
        m.set('text', r.text);
        m.set('src', r.src);
        if (r.by !== undefined) m.set('by', r.by);
        if (r.stale) m.set('stale', true);
        m.set('updatedAt', r.updatedAt);
      }
    });
  }

  /** Called after every transaction that changed the page (local or remote). */
  observe(cb: (tx: Y.Transaction) => void): () => void {
    const h = (tx: Y.Transaction) => {
      if (tx.changed.size > 0) cb(tx);
    };
    this.doc.on('afterTransaction', h);
    return () => this.doc.off('afterTransaction', h);
  }
}

/** Readings that read any of `ids`. */
export function readingsOf(readings: readonly Reading[], ids: Iterable<string>): Reading[] {
  const set = new Set(ids);
  return readings.filter((r) => r.ids.some((id) => set.has(id)));
}

/**
 * The fresh readings that together read every one of `ids`, in reading order of their first stroke's position in
 * `ids`; null if any stroke is unread or only read by a stale reading.
 */
export function freshCover(readings: readonly Reading[], ids: readonly string[]): Reading[] | null {
  if (!ids.length) return null;
  const fresh = readings.filter((r) => !r.stale);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const covering = fresh.filter((r) => r.ids.some((id) => pos.has(id)));
  const covered = new Set(covering.flatMap((r) => r.ids));
  if (!ids.every((id) => covered.has(id))) return null;
  const first = (r: Reading) => Math.min(...r.ids.map((id) => pos.get(id) ?? Infinity));
  return covering.sort((a, b) => first(a) - first(b));
}
