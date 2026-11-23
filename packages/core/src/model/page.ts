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
 * through each transaction in which `Page` methods ran, and dropped as soon as anything else changes the doc: another
 * transaction (remote updates, undo, raw writes), or, inside a transaction, a write between two `Page` calls (seen by
 * a fingerprint of the doc taken when each call returns). The next use rebuilds it from the doc.
 */
interface LineIndex {
  /** The transaction following it; null between transactions (still exact). */
  tx: Y.Transaction | null;
  /** Relative z-position of every item in `order` (only comparisons matter). */
  pos: Map<string, number>;
  next: number;
  /** Ids in `order` whose item is gone (left by concurrent edits). */
  ghosts: Set<string>;
  /** The group of every grouped item (its line field is the group's key), and cached bboxes. */
  lineOf: Map<string, Group>;
  bb: Map<string, BBox>;
  groups: Map<string, Group>;
  /**
   * Items' `line` fields are written when the outermost `Page` call ends, not at every step: a bulk move splits and
   * re-merges each line item by item, which re-keyed every remaining item of the line per step (O(k²) map writes per
   * line of k items, and as many deleted entries for sync and undo to carry), while only the final values matter.
   * `dirty` groups write their key to their items; `pending` holds fields of items outside any group (null: delete).
   * Unchanged fields are not written.
   */
  dirty: Set<Group>;
  pending: Map<string, string | null>;
  /** `fingerprint` of the doc when the last `Page` call in `tx` returned (or the index was built). */
  mark: number;
  /** `medianLineHeight` of the groups; null when a group was added or removed or a line's height or kind changed. */
  median: number | null;
  /**
   * `lines` entries created by line splits during the current `Page` call, by key and kind, written when it returns:
   * moving a whole line splits it item by item and merges the parts back, so most are deleted again in the same call.
   */
  virtual: Map<string, Line['kind']>;
}

/**
 * Lines' readings in one transaction: each line whose items changed, as it was at the start (its item ids and saved
 * reading), and the lines changed since the last `Page` call returned. When a call returns, a changed line whose
 * items differ from the start loses its reading (unless the user wrote it), and one whose items are the same again
 * gets it back. Kept apart from the index, which may be rebuilt within a transaction.
 */
interface Readings {
  tx: Y.Transaction;
  before: Map<string, { ids: Set<string>; text: unknown; textSrc: unknown; conf: unknown }>;
  changed: Set<string>;
}
const readings = new WeakMap<Y.Doc, Readings>();

/**
 * Changes whenever anything is written to the doc within one transaction: inserts advance a client's clock, deletes
 * grow the transaction's delete set. O(clients).
 */
function fingerprint(doc: Y.Doc, tx: Y.Transaction | null): number {
  let n = 0;
  doc.store.clients.forEach((structs) => {
    const last = structs[structs.length - 1];
    if (last) n += last.id.clock + last.length;
  });
  tx?.deleteSet.clients.forEach((d) => {
    n += d.length;
  });
  return n;
}

const indexes = new WeakMap<Y.Doc, LineIndex>();
/** How deep each doc is in `Page` calls (pending line fields are written when it returns to 0). */
const depths = new WeakMap<Y.Doc, number>();
const watched = new WeakSet<Y.Doc>();

/** Merges two id lists by z-position (callers pass lists already in z-order; `b` is sorted if it isn't). */
function mergeByPos(a: string[], b: string[], pos: Map<string, number>): string[] {
  const p = (id: string) => pos.get(id)!;
  for (let i = 1; i < b.length; i++) {
    if (p(b[i - 1]!) > p(b[i]!)) {
      b = [...b].sort((x, y) => p(x) - p(y));
      break;
    }
  }
  if (!a.length) return b.slice();
  if (p(a[a.length - 1]!) < p(b[0]!)) return a.concat(b);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(p(a[i]!) < p(b[j]!) ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/** Keeps a doc's index across transactions that only `Page` methods made, and drops it after any other change. */
function watch(doc: Y.Doc): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  // Before any observer of the transaction can read lines.
  doc.on('beforeObserverCalls', (tx: Y.Transaction) => {
    readings.delete(doc);
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
    this.doc.transact((tx) => {
      const d = depths.get(this.doc) ?? 0;
      if (d === 0) this.peek(); // checks the index against writes made since the last Page call
      depths.set(this.doc, d + 1);
      try {
        fn();
      } finally {
        depths.set(this.doc, d);
        if (d === 0) {
          this.flushLines();
          const ix = indexes.get(this.doc);
          if (ix?.tx === tx) ix.mark = fingerprint(this.doc, tx);
        }
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

  addItem(item: Item): void {
    this.tx(() => {
      const replaced = this.itemMap.has(item.id);
      if (replaced) {
        const ix = this.ix();
        this.detach(ix, [item.id]); // it leaves its line (whose reading is then cleared)
        this.dropIndex();
      }
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
      this.ix(); // so the lines the items leave are noted (their readings are cleared)
      for (const id of ids) {
        const key = this.lineField(id);
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
      for (const key of touched) if (!groups.has(key)) this.deleteEntry(key);
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
      const r = this.readings();
      r?.before.delete(lineKey); // its items now are what this reading is of
      r?.changed.delete(lineKey);
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
    // Outside Page calls, inside a transaction: was anything written since the index last matched the doc?
    if (tx && !depths.get(this.doc)) {
      const stale = ix.tx === tx ? ix.mark !== fingerprint(this.doc, tx) : ix.tx !== null || tx.changed.size > 0;
      if (stale) {
        indexes.delete(this.doc);
        return undefined;
      }
    }
    if (ix.tx === null) ix.tx = tx;
    return ix.tx === tx ? ix : undefined;
  }

  /** The index, built from the doc if there is no current one. */
  private ix(): LineIndex {
    const ix = this.peek();
    if (ix) return ix;
    const tx = this.doc._transaction;
    const built: LineIndex = { tx, pos: new Map(), next: 0, ghosts: new Set(), lineOf: new Map(), bb: new Map(), groups: new Map(), dirty: new Set(), pending: new Map(), mark: 0, median: null, virtual: new Map() };
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
      built.bb.set(id, bb);
      let g = built.groups.get(key);
      if (!g) {
        g = { key, kind: 'line', ids: [], bbox: unionBBox(null, bb), first: idx };
        built.groups.set(key, g);
      }
      built.lineOf.set(id, g);
      g.ids.push(id);
      g.bbox = unionBBox(g.bbox, bb);
    }
    for (const g of built.groups.values()) g.kind = this.kindOf(g);
    built.mark = fingerprint(this.doc, tx);
    watch(this.doc);
    indexes.set(this.doc, built);
    return built;
  }

  /** Forgets the index (after a change it doesn't track); the next read rebuilds it from the doc. */
  private dropIndex(): void {
    this.flushLines();
    indexes.delete(this.doc);
  }

  /** Writes items' changed `line` fields (inside the transaction). */
  private flushLines(): void {
    const ix = indexes.get(this.doc);
    if (!ix) return;
    for (const [key, kind] of ix.virtual) {
      const e = new Y.Map<unknown>();
      this.lineMap.set(key, e);
      e.set('kind', kind);
    }
    ix.virtual.clear();
    for (const [id, key] of ix.pending) {
      const m = this.itemMap.get(id);
      if (!m || ix.lineOf.has(id)) continue; // grouped since: its group writes it
      if (key === null) {
        if (m.has('line')) m.delete('line');
      } else if (m.get('line') !== key) m.set('line', key);
    }
    for (const g of ix.dirty) {
      if (ix.groups.get(g.key) !== g) continue; // emptied
      for (const id of g.ids) {
        const m = this.itemMap.get(id)!;
        if (m.get('line') !== g.key) m.set('line', g.key);
      }
    }
    ix.pending.clear();
    ix.dirty.clear();
    this.settleReadings(ix);
  }

  /** This transaction's `Readings` (none outside a transaction). */
  private readings(): Readings | undefined {
    const tx = this.doc._transaction;
    if (!tx) return undefined;
    let r = readings.get(this.doc);
    if (!r || r.tx !== tx) readings.set(this.doc, (r = { tx, before: new Map(), changed: new Set() }));
    return r;
  }

  /** Notes that line `key`'s items are about to change (call before changing them). */
  private noteChange(ix: LineIndex, key: string): void {
    const r = this.readings();
    if (!r) return;
    r.changed.add(key);
    if (r.before.has(key)) return;
    const e = this.lineMap.get(key);
    r.before.set(key, { ids: new Set(ix.groups.get(key)?.ids), text: e?.get('text'), textSrc: e?.get('textSrc'), conf: e?.get('conf') });
  }

  /**
   * Lines whose items changed lose their reading (unless the user wrote it); lines whose items are the same as at the
   * start of the transaction keep it, e.g. a whole line moved, resized or rotated (assignment splits and re-merges it
   * item by item, but it ends with the same items under the same key).
   */
  private settleReadings(ix: LineIndex): void {
    const r = this.readings();
    if (!r?.changed.size) return;
    for (const key of r.changed) {
      const b = r.before.get(key)!;
      const e = this.lineMap.get(key);
      if (!e) continue;
      const g = ix.groups.get(key);
      const same = !!g && g.ids.length === b.ids.size && g.ids.every((id) => b.ids.has(id));
      const text = e.get('text');
      if (same) {
        if (typeof b.text === 'string' && text !== b.text) {
          e.set('text', b.text);
          e.set('textSrc', b.textSrc);
          if (typeof b.conf === 'number') e.set('conf', b.conf);
          else e.delete('conf');
        }
      } else if (text !== undefined && e.get('textSrc') !== 'user') {
        e.delete('text');
        e.delete('textSrc');
        e.delete('conf');
      }
    }
    r.changed.clear();
  }

  /** An item's `line` field, counting writes not flushed yet. */
  private lineField(id: string): unknown {
    const ix = this.peek();
    if (ix) {
      const g = ix.lineOf.get(id);
      if (g) return g.key;
      if (ix.pending.has(id)) return ix.pending.get(id) ?? undefined;
    }
    return this.itemMap.get(id)?.get('line');
  }

  /** Lines and drawings by key (unordered: sort by `first` for z-order). Live during a transaction: don't keep or mutate. */
  private groups(): Map<string, Group> {
    return this.ix().groups;
  }

  /** A group's kind: its entry's, or (entry missing, e.g. deleted concurrently) a drawing if it has a shape. */
  private kindOf(g: Group): Line['kind'] {
    const v = indexes.get(this.doc)?.virtual.get(g.key);
    if (v) return v;
    const e = this.lineMap.get(g.key);
    if (e) return e.get('kind') === 'drawing' ? 'drawing' : 'line';
    return g.ids.some((id) => this.itemMap.get(id)?.get('type') === 'shape') ? 'drawing' : 'line';
  }

  private refreshKind(key: string): void {
    const ix = this.peek();
    const g = ix?.groups.get(key);
    if (!ix || !g) return;
    const kind = this.kindOf(g);
    if (kind !== g.kind) ix.median = null;
    g.kind = kind;
  }

  /**
   * Updates a group's bbox, first item and kind after its items changed; drops it if empty. `gone` are the bboxes of
   * items that left it (or their old bboxes) and `added` those of items that joined: when nothing that left touched an
   * edge of the box, the other items still span it, so it only grows; otherwise it is recomputed from every item.
   */
  private regroup(ix: LineIndex, g: Group, gone: BBox[] | null, added: BBox[] = []): void {
    if (!g.ids.length) {
      ix.groups.delete(g.key);
      ix.median = null;
      return;
    }
    const b = g.bbox;
    const kind = g.kind;
    if (gone && gone.every((o) => o[0] > b[0] && o[1] > b[1] && o[2] < b[2] && o[3] < b[3])) {
      let bb = b;
      for (const a of added) bb = unionBBox(bb, a);
      g.bbox = bb;
    } else {
      let bb: BBox | null = null;
      for (const id of g.ids) bb = unionBBox(bb, this.cachedBBox(ix, id));
      g.bbox = bb!;
    }
    g.first = ix.pos.get(g.ids[0]!)!;
    g.kind = this.kindOf(g);
    if (gone === null || g.kind !== kind || g.bbox[3] - g.bbox[1] !== b[3] - b[1]) ix.median = null;
  }

  /** Takes items out of their groups in the index. */
  private detach(ix: LineIndex, ids: Iterable<string>): void {
    const from = new Map<Group, { ids: Set<string>; boxes: BBox[] }>();
    for (const id of ids) {
      const g = ix.lineOf.get(id);
      if (!g) continue;
      ix.lineOf.delete(id);
      let s = from.get(g);
      if (!s) from.set(g, (s = { ids: new Set(), boxes: [] }));
      s.ids.add(id);
      s.boxes.push(this.cachedBBox(ix, id));
    }
    for (const [g, gone] of from) {
      this.noteChange(ix, g.key);
      g.ids = g.ids.filter((id) => !gone.ids.has(id));
      this.regroup(ix, g, gone.boxes);
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
    const g = ix.lineOf.get(id);
    if (!g) return;
    const bb = this.cachedBBox(ix, id);
    if (old && old[0] === bb[0] && old[1] === bb[1] && old[2] === bb[2] && old[3] === bb[3]) return;
    this.regroup(ix, g, old ? [old] : null, [bb]);
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
      ix.pending.delete(id);
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
    if (!this.peek()?.virtual.delete(key)) this.lineMap.delete(key);
    this.refreshKind(key);
  }

  /** `newEntry` for a line split off in a `Page` call: virtual until the call returns (see `LineIndex.virtual`). */
  private splitEntry(key: string, kind: Line['kind']): void {
    const ix = this.peek();
    if (!ix || this.lineMap.has(key)) {
      this.newEntry(key, kind);
      return;
    }
    ix.virtual.set(key, kind);
    this.refreshKind(key);
  }

  private setLine(id: string, key: string): void {
    this.setLines([id], key);
  }

  /** Puts items in line `key`. */
  private setLines(ids: string[], key: string): void {
    const ix = this.peek();
    if (!ix) {
      for (const id of ids) this.itemMap.get(id)!.set('line', key);
      return;
    }
    // Only ordered items are grouped (an item missing from `order` keeps its line field but is in no group).
    const add: string[] = [];
    for (const id of ids) {
      if (!ix.pos.has(id)) ix.pending.set(id, key);
      else if (ix.lineOf.get(id)?.key !== key) add.push(id);
    }
    if (!add.length) return;
    this.noteChange(ix, key);
    this.detach(ix, add);
    let g = ix.groups.get(key);
    const fresh = !g;
    if (!g) {
      g = { key, kind: 'line', ids: [], bbox: [0, 0, 0, 0], first: 0 };
      ix.groups.set(key, g);
    }
    for (const id of add) ix.lineOf.set(id, g);
    ix.dirty.add(g);
    g.ids = mergeByPos(g.ids, add, ix.pos);
    this.regroup(ix, g, fresh ? null : [], add.map((id) => this.cachedBBox(ix, id)));
  }

  private unsetLine(id: string): void {
    const ix = this.peek();
    if (!ix) {
      this.itemMap.get(id)!.delete('line');
      return;
    }
    ix.pending.set(id, null);
    this.detach(ix, [id]);
  }

  /**
   * Same as `setLines(others, others[0])` when the key item `id` leaves its group, in O(1) per member: the group is
   * renamed to `others[0]` (members point at their group, so their keys follow) and `id` gets a group of its own
   * under the old key. False (nothing done) if a group under the new key exists already.
   */
  private splitOff(ix: LineIndex, g: Group, id: string, others: string[]): boolean {
    const rest = others[0]!;
    if (ix.groups.has(rest) || ix.lineOf.get(id) !== g) return false;
    const key = g.key;
    this.noteChange(ix, key);
    this.noteChange(ix, rest);
    ix.groups.delete(key);
    g.key = rest;
    g.ids = others;
    ix.groups.set(rest, g);
    ix.dirty.add(g);
    this.regroup(ix, g, [this.cachedBBox(ix, id)]);
    const solo: Group = { key, kind: 'line', ids: [id], bbox: [0, 0, 0, 0], first: 0 };
    ix.groups.set(key, solo);
    ix.lineOf.set(id, solo);
    this.regroup(ix, solo, null);
    return true;
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
    const ix = this.ix();
    ix.median ??= medianLineHeight([...groups.values()]);
    const drawing = this.itemMap.get(id)!.get('type') === 'shape' || b[3] - b[1] > 2.5 * ix.median;
    if (!drawing) {
      const target = this.bestLine(b, groups);
      if (target) {
        this.setLine(id, target.key);
        return;
      }
    }
    const e = this.lineMap.get(id);
    if (ix.virtual.has(id)) {
      ix.virtual.set(id, drawing ? 'drawing' : 'line');
      this.refreshKind(id);
    } else if (e) {
      e.set('kind', drawing ? 'drawing' : 'line');
      this.refreshKind(id);
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
    const key = this.lineField(id);
    if (typeof key !== 'string') return this.assign(id);
    let groups = this.groups();
    const g = groups.get(key);
    if (!g) return this.assign(id);
    const ix = this.ix();
    const b = this.cachedBBox(ix, id);
    const others = g.ids.filter((x) => x !== id);
    if (others.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const o of others) {
        const q = this.cachedBBox(ix, o);
        if (q[0] < x0) x0 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[2] > x1) x1 = q[2];
        if (q[3] > y1) y1 = q[3];
      }
      const ob: BBox = [x0, y0, x1, y1];
      if (g.kind === 'line' ? fitsLine(b, ob) : intersects(b, ob)) return; // still belongs here
      if (id !== key) {
        this.unsetLine(id);
        return this.assign(id);
      }
      // The line follows its key item; the remaining items split off under their first item's id.
      const rest = others[0]!;
      this.splitEntry(rest, g.kind);
      if (!this.splitOff(ix, g, id, others)) this.setLines(others, rest);
      groups = this.groups();
    }
    // Alone in its line: merge with a line (or drawings) it now fits.
    const self = groups.get(key)!;
    if (self.kind === 'drawing') return this.mergeDrawings(key);
    const target = this.bestLine(b, groups, key);
    if (target) this.merge(self, target);
  }
}
