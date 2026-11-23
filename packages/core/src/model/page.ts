import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { encodePoints, decodePoints } from '../points';
import { itemBBox, intersects, unionBBox } from '../geometry/bbox';
import { newId } from '../ids';
import type { Author, BBox, Comment, InkPoint, Item, Line, TextSrc } from '../types';

type YItem = Y.Map<unknown>;

interface Group { key: string; kind: Line['kind']; ids: string[]; bbox: BBox; first: number }

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

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.itemMap = doc.getMap('items');
    this.order = doc.getArray('order');
    this.lineMap = doc.getMap('lines');
    this.commentMap = doc.getMap('comments');
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

  /** Items in z-order. */
  items(): Item[] {
    return this.orderedIds().map((id) => readItem(this.itemMap.get(id)!));
  }

  item(id: string): Item | undefined {
    const m = this.itemMap.get(id);
    return m ? readItem(m) : undefined;
  }

  addItem(item: Item): void {
    this.tx(() => {
      const m = new Y.Map<unknown>();
      this.itemMap.set(item.id, m);
      m.set('id', item.id);
      m.set('type', item.type);
      setFields(m, item as unknown as Record<string, unknown>);
      this.order.push([item.id]);
      if (item.type === 'stroke' || item.type === 'shape') this.assign(item.id);
    });
  }

  updateItem(id: string, patch: Partial<Item>): void {
    this.tx(() => {
      const m = this.itemMap.get(id);
      if (!m) return;
      setFields(m, patch as Record<string, unknown>);
      const type = m.get('type');
      if ((type === 'stroke' || type === 'shape') && Object.keys(patch).some((k) => GEOMETRY_KEYS.has(k))) {
        this.relayout(id);
      }
    });
  }

  removeItems(ids: string[]): void {
    this.tx(() => {
      const gone = new Set(ids);
      const touched = new Set<string>();
      for (const id of ids) {
        const key = this.itemMap.get(id)?.get('line');
        if (typeof key === 'string') touched.add(key);
        this.itemMap.delete(id);
      }
      const arr = this.order.toArray();
      for (let i = arr.length - 1; i >= 0; i--) if (gone.has(arr[i]!)) this.order.delete(i, 1);
      const groups = this.groups();
      for (const key of touched) {
        if (groups.has(key)) this.touch(key);
        else this.lineMap.delete(key);
      }
    });
  }

  /** Lines and drawings, ordered by their first item's z-order. */
  lines(): Line[] {
    return [...this.groups().values()].map((g) => {
      const e = this.lineMap.get(g.key);
      const line: Line = { key: g.key, kind: g.kind, itemIds: g.ids, bbox: g.bbox };
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

  /** Called after every transaction that changed the page (local or remote). */
  observe(cb: (tx: Y.Transaction) => void): () => void {
    const h = (tx: Y.Transaction) => {
      if (tx.changed.size > 0) cb(tx);
    };
    this.doc.on('afterTransaction', h);
    return () => this.doc.off('afterTransaction', h);
  }

  // ---- line assignment (always runs inside a transaction) ----

  private groups(): Map<string, Group> {
    const groups = new Map<string, Group>();
    this.orderedIds().forEach((id, idx) => {
      const m = this.itemMap.get(id)!;
      const key = m.get('line');
      if (typeof key !== 'string') return;
      const bb = itemBBox(readGeometry(m));
      let g = groups.get(key);
      if (!g) {
        const kind = this.lineMap.get(key)?.get('kind');
        g = { key, kind: kind === 'drawing' ? 'drawing' : 'line', ids: [], bbox: bb, first: idx };
        groups.set(key, g);
      }
      // Entry missing (deleted concurrently): a group with a shape is a drawing.
      if (!this.lineMap.has(key) && m.get('type') === 'shape') g.kind = 'drawing';
      g.ids.push(id);
      g.bbox = unionBBox(g.bbox, bb);
    });
    return groups;
  }

  private bboxOf(id: string): BBox {
    return itemBBox(readGeometry(this.itemMap.get(id)!));
  }

  private newEntry(key: string, kind: Line['kind']): Y.Map<unknown> {
    const e = new Y.Map<unknown>();
    this.lineMap.set(key, e);
    e.set('kind', kind);
    return e;
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
    this.itemMap.get(id)!.set('line', key);
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
      this.touch(id);
    } else this.newEntry(id, drawing ? 'drawing' : 'line');
    this.setLine(id, id);
    if (drawing) this.mergeDrawings(id);
  }

  /** Merges two groups; the one whose first item is earliest in z-order keeps its key. */
  private merge(a: Group, b: Group): string {
    const [win, lose] = a.first <= b.first ? [a, b] : [b, a];
    for (const id of lose.ids) this.setLine(id, win.key);
    this.lineMap.delete(lose.key);
    this.touch(win.key);
    return win.key;
  }

  private mergeDrawings(key: string): void {
    for (;;) {
      const groups = this.groups();
      const g = groups.get(key);
      if (!g) return;
      const other = [...groups.values()].find((o) => o.kind === 'drawing' && o.key !== key && intersects(o.bbox, g.bbox));
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
        m.delete('line');
        this.touch(key);
        return this.assign(id);
      }
      // The line follows its key item; the remaining items split off under their first item's id.
      const rest = others[0]!;
      this.newEntry(rest, g.kind);
      for (const o of others) this.setLine(o, rest);
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
