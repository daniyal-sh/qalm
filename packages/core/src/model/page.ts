import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { encodePoints, decodePoints } from '../points';
import { itemBBox, intersects, unionBBox } from '../geometry/bbox';
import { newId } from '../ids';
import type { Author, BBox, Comment, InkPoint, Item, Line, TextSrc } from '../types';

type YItem = Y.Map<unknown>;

interface Group { key: string; kind: Line['kind']; ids: string[]; bbox: BBox; first: number }

/**
 * A page doc's line grouping: what line assignment used to recompute from every item on each step, kept up to date
 * by the steps instead. Shared by every `Page` wrapping the doc. It is built from the doc on first use, followed
 * through each transaction in which `Page` methods ran, and dropped as soon as any other transaction changes the doc
 * (remote updates, undo, raw writes), so the next use rebuilds it. Don't mix raw writes to `items`, `order` or `lines`
 * with `Page` calls inside one transaction: the index wouldn't see them.
 */
interface LineIndex {
  /** The transaction following it; null between transactions (still exact). */
  tx: Y.Transaction | null;
  /** Relative z-position of every item in `order` (only comparisons matter). */
  pos: Map<string, number>;
  next: number;
  /** Ids in `order` whose item is gone (left by concurrent edits). */
  ghosts: Set<string>;
  /** Line key of every grouped item, and cached bboxes. */
  lineOf: Map<string, string>;
  bb: Map<string, BBox>;
  groups: Map<string, Group>;
}

const indexes = new WeakMap<Y.Doc, LineIndex>();
const watched = new WeakSet<Y.Doc>();

/** Keeps a doc's index across transactions that only `Page` methods made, and drops it after any other change. */
function watch(doc: Y.Doc): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  // Before any observer of the transaction can read lines.
  doc.on('beforeObserverCalls', (tx: Y.Transaction) => {
    const ix = indexes.get(doc);
    if (!ix) return;
    if (ix.tx === tx) ix.tx = null;
    else if (tx.changed.size > 0) indexes.delete(doc);
  });
}

/** Line height assumed while a page has no lines yet. */
const DEFAULT_LINE_HEIGHT = 24;
const GEOMETRY_KEYS = new Set(['points', 'bbox', 'x', 'y', 'w', 'h', 'pts']);

/** A stroke joins a line if vertical overlap >= 50% of the smaller height and the horizontal gap <= 1.5x the line's height. */
export function fitsLine(b: BBox, line: BBox): boolean {
  const h = b[3] - b[1];
  const lh = line[3] - line[1];
  const overlap = Math.min(b[3], line[3]) - Math.max(b[1], line[1]);
  const gap = Math.max(0, Math.max(b[0], line[0]) - Math.min(b[2], line[2]));
  return overlap >= 0.5 * Math.min(h, lh) && gap <= 1.5 * lh;
}

export function medianLineHeight(lines: { kind: Line['kind']; bbox: BBox }[]): number {
  const xs = lines.filter((l) => l.kind === 'line').map((l) => l.bbox[3] - l.bbox[1]);
  if (!xs.length) return DEFAULT_LINE_HEIGHT;
  const s = xs.sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function readItem(m: YItem): Item {
  const o: Record<string, unknown> = {};
  m.forEach((v, k) => {
    if (k === 'line') return;
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

/**
 * Wraps one page doc.
 *
 * Each stroke/shape item stores its line key in an internal `line` field. A line's `itemIds` and `bbox` are
 * derived from its items, and the `lines` map holds each line's `kind` and text. Grouping therefore stays
 * consistent however concurrent edits from several devices merge.
 */
export class Page {
  readonly doc: Y.Doc;
  private readonly itemMap: Y.Map<YItem>;
  private readonly order: Y.Array<string>;
  private readonly lineMap: Y.Map<Y.Map<unknown>>;
  private readonly commentMap: Y.Map<Y.Map<unknown>>;
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
    this.lineMap = doc.getMap('lines');
    this.commentMap = doc.getMap('comments');
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
    this.doc.transact(fn, LOCAL_ORIGIN);
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

  addItem(item: Item): void {
    this.tx(() => {
      const replaced = this.itemMap.has(item.id);
      const m = new Y.Map<unknown>();
      this.dirty();
      this.itemMap.set(item.id, m);
      m.set('id', item.id);
      m.set('type', item.type);
      setFields(m, item as unknown as Record<string, unknown>);
      this.order.push([item.id]);
      this.indexAdded(item.id, replaced);
      if (item.type === 'stroke' || item.type === 'shape') this.assign(item.id);
    });
  }

  /**
   * Adds items in one transaction (one undo step), in order: the same result as `addItem` for each. Line assignment
   * keeps its grouping up to date within a transaction, so this is linear-ish rather than quadratic in the page size.
   */
  addItems(items: readonly Item[]): void {
    this.tx(() => {
      for (const it of items) this.addItem(it);
    });
  }

  updateItem(id: string, patch: Partial<Item>): void {
    this.tx(() => {
      const m = this.itemMap.get(id);
      if (!m) return;
      this.dirty(m);
      setFields(m, patch as Record<string, unknown>);
      this.indexUpdated(id);
      const type = m.get('type');
      if ((type === 'stroke' || type === 'shape') && Object.keys(patch).some((k) => GEOMETRY_KEYS.has(k))) {
        this.relayout(id);
      }
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
      this.dropIndex();
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
      const touched = new Set<string>();
      this.dirty();
      for (const id of ids) {
        const key = this.itemMap.get(id)?.get('line');
        if (typeof key === 'string') touched.add(key);
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
      this.indexRemoved([...gone]);
      const groups = this.groups();
      for (const key of touched) {
        if (groups.has(key)) this.touch(key);
        else this.deleteEntry(key);
      }
    });
  }

  /** Lines and drawings, ordered by their first item's z-order. */
  lines(): Line[] {
    return [...this.groups().values()].sort((a, b) => a.first - b.first).map((g) => {
      const e = this.lineMap.get(g.key);
      const line: Line = { key: g.key, kind: g.kind, itemIds: [...g.ids], bbox: g.bbox };
      const text = e?.get('text');
      if (typeof text === 'string') {
        line.text = text;
        line.textSrc = e!.get('textSrc') as TextSrc;
        const conf = e!.get('conf');
        if (typeof conf === 'number') line.conf = conf;
      }
      return line;
    });
  }

  setLineText(lineKey: string, text: string, src: TextSrc, conf?: number): void {
    this.tx(() => {
      let e = this.lineMap.get(lineKey);
      if (!e) {
        const g = this.groups().get(lineKey);
        if (!g) return;
        e = this.newEntry(lineKey, g.kind);
      }
      const cur = e.get('textSrc');
      // On-device guesses never overwrite trusted (agent or user) text.
      if (src === 'device' && (cur === 'agent' || cur === 'user') && typeof e.get('text') === 'string') return;
      e.set('text', text);
      e.set('textSrc', src);
      if (conf === undefined) e.delete('conf');
      else e.set('conf', conf);
    });
  }

  comments(): Comment[] {
    const out: Comment[] = [];
    this.commentMap.forEach((m) => {
      const replies = m.get('replies') as Y.Array<Comment['replies'][number]> | undefined;
      const c: Comment = {
        id: m.get('id') as string,
        lineKey: m.get('lineKey') as string,
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

  /**
   * Starts a thread on a line (`lineKey`; '' when the selection has no ink line) or on a selection (`anchor`).
   * Agents start threads only on lines.
   */
  addComment(c: Omit<Comment, 'id' | 'createdAt' | 'resolved' | 'replies'>): string {
    const id = newId();
    this.tx(() => {
      const m = new Y.Map<unknown>();
      this.commentMap.set(id, m);
      m.set('id', id);
      m.set('lineKey', c.lineKey);
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
   * Copies another page's items (with new ids, same z-order, same line grouping and line text) into this one, in one
   * transaction. Comments are not copied (they are threads about the original). Linear in the number of items.
   */
  copyFrom(src: Page, makeId: () => string = newId): void {
    const ids = new Map<string, string>();
    for (const id of src.orderedIds()) ids.set(id, makeId());
    this.tx(() => {
      this.dirty();
      this.dropIndex();
      const order: string[] = [];
      for (const [oldId, id] of ids) {
        const from = src.itemMap.get(oldId)!;
        const m = new Y.Map<unknown>();
        this.itemMap.set(id, m);
        from.forEach((v, k) => {
          if (k === 'id') m.set('id', id);
          else if (k === 'line') m.set('line', ids.get(v as string) ?? id);
          else m.set(k, v instanceof Uint8Array ? v.slice() : Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v);
        });
        order.push(id);
      }
      this.order.push(order);
      src.lineMap.forEach((e, key) => {
        const k = ids.get(key);
        if (!k) return;
        const m = new Y.Map<unknown>();
        this.lineMap.set(k, m);
        e.forEach((v, f) => m.set(f, v));
      });
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

  // ---- line assignment (always runs inside a transaction) ----
  //
  // Each step (assign, relayout, merge) reads the page's grouping. It used to be rebuilt from every item on each read,
  // which made a bulk edit of n items O(n²). The grouping now lives in a per-transaction `LineIndex` that each step
  // keeps up to date; the steps themselves, and so their results, are unchanged.

  /** The index, if there is a current one, joined to the running transaction (does not build it). */
  private peek(): LineIndex | undefined {
    const ix = indexes.get(this.doc);
    if (!ix) return undefined;
    const tx = this.doc._transaction;
    if (ix.tx === null) ix.tx = tx;
    return ix.tx === tx ? ix : undefined;
  }

  /** The index, built from the doc if there is no current one. */
  private ix(): LineIndex {
    const ix = this.peek();
    if (ix) return ix;
    const tx = this.doc._transaction;
    const built: LineIndex = { tx, pos: new Map(), next: 0, ghosts: new Set(), lineOf: new Map(), bb: new Map(), groups: new Map() };
    for (const id of this.order.toArray()) {
      if (built.pos.has(id) || built.ghosts.has(id)) continue;
      const m = this.itemMap.get(id);
      if (!m) {
        built.ghosts.add(id);
        continue;
      }
      const idx = built.next++;
      built.pos.set(id, idx);
      const key = m.get('line');
      if (typeof key !== 'string') continue;
      const bb = itemBBox(readGeometry(m));
      built.lineOf.set(id, key);
      built.bb.set(id, bb);
      let g = built.groups.get(key);
      if (!g) {
        g = { key, kind: 'line', ids: [], bbox: unionBBox(null, bb), first: idx };
        built.groups.set(key, g);
      }
      g.ids.push(id);
      g.bbox = unionBBox(g.bbox, bb);
    }
    for (const g of built.groups.values()) g.kind = this.kindOf(g);
    watch(this.doc);
    indexes.set(this.doc, built);
    return built;
  }

  /** Forgets the index (after a change it doesn't track); the next read rebuilds it from the doc. */
  private dropIndex(): void {
    indexes.delete(this.doc);
  }

  /** Lines and drawings by key (unordered: sort by `first` for z-order). Live during a transaction: don't keep or mutate. */
  private groups(): Map<string, Group> {
    return this.ix().groups;
  }

  /** A group's kind: its entry's, or (entry missing, e.g. deleted concurrently) a drawing if it has a shape. */
  private kindOf(g: Group): Line['kind'] {
    const e = this.lineMap.get(g.key);
    if (e) return e.get('kind') === 'drawing' ? 'drawing' : 'line';
    return g.ids.some((id) => this.itemMap.get(id)?.get('type') === 'shape') ? 'drawing' : 'line';
  }

  private refreshKind(key: string): void {
    const g = this.peek()?.groups.get(key);
    if (g) g.kind = this.kindOf(g);
  }

  /** Recomputes a group's bbox, first item and kind after its items changed; drops it if empty. */
  private regroup(ix: LineIndex, g: Group): void {
    if (!g.ids.length) {
      ix.groups.delete(g.key);
      return;
    }
    let bb: BBox | null = null;
    for (const id of g.ids) bb = unionBBox(bb, this.cachedBBox(ix, id));
    g.bbox = bb!;
    g.first = ix.pos.get(g.ids[0]!)!;
    g.kind = this.kindOf(g);
  }

  /** Takes items out of their groups in the index. */
  private detach(ix: LineIndex, ids: Iterable<string>): void {
    const from = new Map<string, Set<string>>();
    for (const id of ids) {
      const key = ix.lineOf.get(id);
      if (key === undefined) continue;
      ix.lineOf.delete(id);
      let s = from.get(key);
      if (!s) from.set(key, (s = new Set()));
      s.add(id);
    }
    for (const [key, gone] of from) {
      const g = ix.groups.get(key)!;
      g.ids = g.ids.filter((id) => !gone.has(id));
      this.regroup(ix, g);
    }
  }

  private cachedBBox(ix: LineIndex, id: string): BBox {
    let bb = ix.bb.get(id);
    if (!bb) {
      bb = itemBBox(readGeometry(this.itemMap.get(id)!));
      ix.bb.set(id, bb);
    }
    return bb;
  }

  private bboxOf(id: string): BBox {
    return this.cachedBBox(this.ix(), id);
  }

  /** An item was added at the top of the z-order (after `order.push`). */
  private indexAdded(id: string, replaced: boolean): void {
    const ix = this.peek();
    if (!ix) return;
    // Re-adding an id the order already holds keeps its old slot: rebuild rather than track that.
    if (replaced || ix.pos.has(id) || ix.ghosts.has(id)) return this.dropIndex();
    ix.pos.set(id, ix.next++);
  }

  /** An item's fields changed: refresh its bbox and its group's. */
  private indexUpdated(id: string): void {
    const ix = this.peek();
    if (!ix) return;
    const old = ix.bb.get(id);
    ix.bb.delete(id);
    const key = ix.lineOf.get(id);
    if (key === undefined) return;
    const bb = this.cachedBBox(ix, id);
    if (old && old[0] === bb[0] && old[1] === bb[1] && old[2] === bb[2] && old[3] === bb[3]) return;
    this.regroup(ix, ix.groups.get(key)!);
  }

  /** Items were deleted (from `items` and every slot of `order`). */
  private indexRemoved(ids: string[]): void {
    const ix = this.peek();
    if (!ix) return;
    this.detach(ix, ids);
    for (const id of ids) {
      ix.pos.delete(id);
      ix.bb.delete(id);
      ix.ghosts.delete(id);
    }
  }

  private newEntry(key: string, kind: Line['kind']): Y.Map<unknown> {
    const e = new Y.Map<unknown>();
    this.lineMap.set(key, e);
    e.set('kind', kind);
    this.refreshKind(key);
    return e;
  }

  private deleteEntry(key: string): void {
    this.lineMap.delete(key);
    this.refreshKind(key);
  }

  /** A line's items changed: clear its text unless the user wrote it. */
  private touch(key: string): void {
    const e = this.lineMap.get(key);
    if (!e || e.get('textSrc') === 'user') return;
    e.delete('text');
    e.delete('textSrc');
    e.delete('conf');
  }

  private setLine(id: string, key: string): void {
    this.setLines([id], key);
  }

  /** Puts items in line `key`. */
  private setLines(ids: string[], key: string): void {
    for (const id of ids) this.itemMap.get(id)!.set('line', key);
    const ix = this.peek();
    if (!ix) return;
    // Only ordered items are grouped (an item missing from `order` keeps its line field but is in no group).
    const add = ids.filter((id) => ix.pos.has(id) && ix.lineOf.get(id) !== key);
    if (!add.length) return;
    this.detach(ix, add);
    for (const id of add) ix.lineOf.set(id, key);
    let g = ix.groups.get(key);
    if (!g) {
      g = { key, kind: 'line', ids: [], bbox: [0, 0, 0, 0], first: 0 };
      ix.groups.set(key, g);
    }
    const pos = ix.pos;
    g.ids = g.ids.concat(add).sort((a, b) => pos.get(a)! - pos.get(b)!);
    this.regroup(ix, g);
  }

  private unsetLine(id: string): void {
    this.itemMap.get(id)!.delete('line');
    const ix = this.peek();
    if (ix) this.detach(ix, [id]);
  }

  /** The best line for bbox `b`: smallest gap, then largest overlap, then smallest key. */
  private bestLine(b: BBox, groups: Map<string, Group>, exclude?: string): Group | undefined {
    let best: Group | undefined;
    let bestGap = Infinity;
    let bestOverlap = -Infinity;
    for (const g of groups.values()) {
      if (g.kind !== 'line' || g.key === exclude || !fitsLine(b, g.bbox)) continue;
      const gap = Math.max(0, Math.max(b[0], g.bbox[0]) - Math.min(b[2], g.bbox[2]));
      const overlap = Math.min(b[3], g.bbox[3]) - Math.max(b[1], g.bbox[1]);
      const better = !best || gap < bestGap || (gap === bestGap && (overlap > bestOverlap || (overlap === bestOverlap && g.key < best.key)));
      if (better) {
        best = g;
        bestGap = gap;
        bestOverlap = overlap;
      }
    }
    return best;
  }

  /** Assigns an item that has no line yet. */
  private assign(id: string): void {
    const b = this.bboxOf(id);
    const groups = this.groups();
    const drawing = this.itemMap.get(id)!.get('type') === 'shape' || b[3] - b[1] > 2.5 * medianLineHeight([...groups.values()]);
    if (!drawing) {
      const target = this.bestLine(b, groups);
      if (target) {
        this.setLine(id, target.key);
        this.touch(target.key);
        return;
      }
    }
    const e = this.lineMap.get(id);
    if (e) {
      e.set('kind', drawing ? 'drawing' : 'line');
      this.refreshKind(id);
      this.touch(id);
    } else this.newEntry(id, drawing ? 'drawing' : 'line');
    this.setLine(id, id);
    if (drawing) this.mergeDrawings(id);
  }

  /** Merges two groups; the one whose first item is earliest in z-order keeps its key. */
  private merge(a: Group, b: Group): string {
    const [win, lose] = a.first <= b.first ? [a, b] : [b, a];
    const key = win.key;
    this.setLines([...lose.ids], key);
    this.deleteEntry(lose.key);
    this.touch(key);
    return key;
  }

  private mergeDrawings(key: string): void {
    for (;;) {
      const groups = this.groups();
      const g = groups.get(key);
      if (!g) return;
      // The first overlapping drawing in z-order.
      let other: Group | undefined;
      for (const o of groups.values()) {
        if (o.kind === 'drawing' && o.key !== key && intersects(o.bbox, g.bbox) && (!other || o.first < other.first)) other = o;
      }
      if (!other) return;
      key = this.merge(g, other);
    }
  }

  /** The geometry of an assigned item changed (e.g. moved by lasso). */
  private relayout(id: string): void {
    const m = this.itemMap.get(id)!;
    const key = m.get('line');
    if (typeof key !== 'string') return this.assign(id);
    let groups = this.groups();
    const g = groups.get(key);
    if (!g) return this.assign(id);
    const b = this.bboxOf(id);
    const others = g.ids.filter((x) => x !== id);
    if (others.length) {
      let ob: BBox | null = null;
      for (const o of others) ob = unionBBox(ob, this.bboxOf(o));
      if (g.kind === 'line' ? fitsLine(b, ob!) : intersects(b, ob!)) return; // still belongs here
      if (id !== key) {
        this.unsetLine(id);
        this.touch(key);
        return this.assign(id);
      }
      // The line follows its key item; the remaining items split off under their first item's id.
      const rest = others[0]!;
      this.newEntry(rest, g.kind);
      this.setLines(others, rest);
      this.touch(key);
      groups = this.groups();
    }
    // Alone in its line: merge with a line (or drawings) it now fits.
    const self = groups.get(key)!;
    if (self.kind === 'drawing') return this.mergeDrawings(key);
    const target = this.bestLine(b, groups, key);
    if (target) this.merge(self, target);
  }
}
