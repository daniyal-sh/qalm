import type { Notebook } from './model/notebook';
import { freshCover, readingsOf, type Page } from './model/page';
import { itemBBox, pointsBBox, unionBBox } from './geometry/bbox';
import { shapePolylines } from './geometry/shape';
import {
  CLUSTER_GAP,
  boxGap,
  boxRef,
  clusterBoxes,
  contextFor,
  fromGrid,
  gridPlace,
  gridSize,
  isInk,
  pageUnit,
  sortReading,
} from './geometry/regions';
import { anchorInkRemoved, threadBox } from './anchor';
import type { RegionRow } from './render/regions';
import type { Ask, BBox, Comment, Item, PageInfo, Reading } from './types';

/**
 * Q-ink Live v1.0 (qink-live.md). Agents get **regions**: crops of the strokes added or erased since their last
 * update, with the ink around them for context, on a 0–1000 grid across the page width.
 */

/** What an agent last saw of a page's ink: stroke id → signature (`inkSig`). Stored per agent and page by the server. */
export type InkSeen = Record<string, string>;
/** A region label's meaning: its page, strokes and box (page units). `client`: the agent it was sent to. */
export interface QinkRegion { pageId: string; ids: string[]; box: BBox; client?: string; replaced?: boolean; at?: number }
/** Region labels (`R1`, `R2`, …), notebook-wide and never reused. Stored by the server, never in Yjs. */
export interface QinkRegions { next: number; byLabel: Record<string, QinkRegion> }
/** The one image of an update or read: its rows (render with `renderRegionsSvg`). */
export interface QinkImage { rows: RegionRow[] }
/** Short thread labels (`C1`, `C2`, …), notebook-wide and never reused. Stored by the server, never in Yjs. */
export interface QinkThreads { next: number; byId: Record<string, { label: string; pageId: string }> }
/** What one agent has seen of each thread: comment id -> number of entries (the comment plus its replies). */
export type QinkSeen = Record<string, number>;
/** An Ask as the encoder needs it. */
export type QinkAsk = Pick<Ask, 'pageId' | 'text' | 'sel' | 'commentId'>;

export const emptyThreads = (): QinkThreads => ({ next: 1, byId: {} });
export const emptyRegions = (): QinkRegions => ({ next: 1, byLabel: {} });
/** Regions kept in the registry; the oldest replaced ones are forgotten first (their labels are never reused). */
export const MAX_REGIONS = 600;

// ---- threads ----

/** The thread's label, assigning the next one if it has none. */
export function threadLabel(threads: QinkThreads, commentId: string, pageId: string): string {
  const hit = threads.byId[commentId];
  if (hit) return hit.label;
  const label = `C${threads.next++}`;
  threads.byId[commentId] = { label, pageId };
  return label;
}

/** Resolves `C3` to its page and comment id, for `comment` with `thread`. */
export function resolveThread(threads: QinkThreads, ref: string): { pageId: string; commentId: string } {
  const want = ref.trim().toUpperCase();
  if (!/^C\d+$/.test(want)) throw new Error(`Bad thread: ${ref} (expected e.g. C3)`);
  const hit = Object.entries(threads.byId).find(([, v]) => v.label === want);
  if (!hit) throw new Error(`No thread ${want}`);
  return { pageId: hit[1].pageId, commentId: hit[0] };
}

/** Thread entries are quoted up to this many characters. */
const MAX_NOTE = 1000;
const clip = (t: string) => (t.length > MAX_NOTE ? `${t.slice(0, MAX_NOTE)}…` : t);
const quote = (s: string) => JSON.stringify(s);
const who = (a: Comment['author']) => (a.kind === 'agent' ? 'agent' : 'student');

// ---- ink signatures: what the agent saw, compactly (detects moves; draws erased strokes) ----

/** Signature points are this far apart at least (page units), at most this many, on a 0.5-unit lattice. */
const SIG_STEP = 1.5;
const SIG_MAX = 24;

function polyline(it: Item): [number, number][] {
  if (it.type === 'stroke') return it.points.map((p) => [p.x, p.y]);
  if (it.type === 'shape') return shapePolylines(it).flat();
  return [];
}

/**
 * A stroke's signature: its path simplified (points ≥ 1.5 units apart, at most 24) on a half-unit lattice, delta
 * encoded. Equal signatures = the agent has seen this ink where it is now; a different one means it moved.
 */
export function inkSig(it: Item): string {
  const pl = polyline(it);
  if (!pl.length) return '';
  const kept: [number, number][] = [pl[0]!];
  for (const p of pl) {
    const l = kept[kept.length - 1]!;
    if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= SIG_STEP) kept.push(p);
  }
  const last = pl[pl.length - 1]!;
  if (kept.length > 1 || kept[0] !== last) kept.push(last);
  let pts = kept;
  if (pts.length > SIG_MAX) pts = Array.from({ length: SIG_MAX }, (_, i) => kept[Math.round((i * (kept.length - 1)) / (SIG_MAX - 1))]!);
  let px = 0, py = 0;
  return pts
    .map(([x, y]) => {
      const qx = Math.round(x * 2), qy = Math.round(y * 2);
      const s = `${qx - px},${qy - py}`;
      px = qx;
      py = qy;
      return s;
    })
    .join(' ');
}

/** The polyline (page units) of a signature. */
export function sigPolyline(sig: string): [number, number][] {
  if (!sig) return [];
  let x = 0, y = 0;
  return sig.split(' ').map((s) => {
    const [dx, dy] = s.split(',').map(Number);
    x += dx!;
    y += dy!;
    return [x / 2, y / 2];
  });
}

const sigBox = (pl: [number, number][]): BBox => pointsBBox(pl.map(([x, y]) => ({ x, y })), 0.5);

/** Current ink signatures of a page. */
const polyLength = (pl: readonly [number, number][]) => pl.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - pl[i - 1]![0], p[1] - pl[i - 1]![1]) : 0), 0);

/** Whether a stroke's new path is a shorter one inside its old box (partly erased), not a move or a new stroke. */
function shrank(before: [number, number][], now: [number, number][]): boolean {
  if (before.length < 2 || now.length < 1) return false;
  const a = sigBox(before);
  const b = sigBox(now);
  const tol = 0.5;
  return b[0] >= a[0] - tol && b[1] >= a[1] - tol && b[2] <= a[2] + tol && b[3] <= a[3] + tol && polyLength(now) < polyLength(before) - tol;
}

export function pageInk(page: Page): InkSeen {
  const out: InkSeen = {};
  for (const it of page.items()) if (isInk(it)) out[it.id] = inkSig(it);
  return out;
}

// ---- regions ----

/** A region before it has a label. */
interface Draft { pageId: string; fresh: string[]; context: string[]; erased: [number, number][][]; box: BBox; first?: boolean }

interface PageCtx { pageId: string; pos: number; info: PageInfo; page: Page; ink: Item[]; boxes: Map<string, BBox>; unit: number }

function pageCtx(page: Page, pageId: string, pos: number, info: PageInfo): PageCtx {
  const ink = page.items().filter(isInk);
  const boxes = new Map(ink.map((it) => [it.id, itemBBox(it)]));
  return { pageId, pos, info, page, ink, boxes, unit: pageUnit(info.background.kind === 'pdf' ? undefined : info.paper, [...boxes.values()]) };
}

/**
 * Regions of changed ink (qink-live.md §2): the changed strokes (`fresh` ids, and erased polylines) clustered with
 * `clusterBoxes` (gap < 2 units), each with its context (`contextFor`). Regions whose boxes overlap once context is
 * added are merged, so no two regions overlap and every changed stroke is in exactly one.
 */
export function changeRegions(ctx: PageCtx, fresh: readonly string[], erased: readonly [number, number][][]): Draft[] {
  const changed: { id?: string; pl?: [number, number][]; box: BBox }[] = [
    ...fresh.filter((id) => ctx.boxes.has(id)).map((id) => ({ id, box: ctx.boxes.get(id)! })),
    ...erased.filter((pl) => pl.length).map((pl) => ({ pl, box: sigBox(pl) })),
  ];
  if (!changed.length) return [];
  const freshSet = new Set(fresh);
  const others = ctx.ink.filter((it) => !freshSet.has(it.id));
  const otherBoxes = others.map((it) => ctx.boxes.get(it.id)!);
  let drafts: Draft[] = clusterBoxes(changed.map((c) => c.box), CLUSTER_GAP * ctx.unit).map((g) => {
    const cs = g.map((i) => changed[i]!);
    const seeds = cs.map((c) => c.box);
    const context = contextFor(seeds, otherBoxes, ctx.unit).map((j) => others[j]!.id);
    let box: BBox | null = null;
    for (const b of seeds) box = unionBBox(box, b);
    for (const id of context) box = unionBBox(box, ctx.boxes.get(id)!);
    return { pageId: ctx.pageId, fresh: cs.flatMap((c) => (c.id ? [c.id] : [])), erased: cs.flatMap((c) => (c.pl ? [c.pl] : [])), context, box: box! };
  });
  // Context can make two regions overlap: merge them (a stroke that is context of one and new in another is new).
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let a = 0; a < drafts.length; a++) {
      for (let b = a + 1; b < drafts.length; b++) {
        const A = drafts[a]!, B = drafts[b]!;
        if (boxGap(A.box, B.box) > 0) continue;
        const f = new Set([...A.fresh, ...B.fresh]);
        drafts[a] = {
          pageId: ctx.pageId,
          fresh: [...f],
          erased: [...A.erased, ...B.erased],
          context: [...new Set([...A.context, ...B.context])].filter((id) => !f.has(id)),
          box: unionBBox(A.box, B.box),
        };
        drafts.splice(b, 1);
        merged = true;
        break outer;
      }
    }
  }
  drafts = sortReading(drafts);
  return drafts;
}

/** A first look: all of the page's ink, clustered into regions (no context: everything is in some region). */
export function firstLookRegions(ctx: PageCtx): Draft[] {
  const ids = ctx.ink.map((it) => it.id);
  const groups = clusterBoxes(ids.map((id) => ctx.boxes.get(id)!), CLUSTER_GAP * ctx.unit);
  return groups.map((g) => {
    let box: BBox | null = null;
    for (const i of g) box = unionBBox(box, ctx.boxes.get(ids[i]!)!);
    return { pageId: ctx.pageId, fresh: g.map((i) => ids[i]!), context: [], erased: [], box: box!, first: true };
  });
}

/** The region a selection is about: the selected items (black) plus context ink (grey); null without items. */
function selectionDraft(ctx: PageCtx, itemIds: readonly string[]): Draft | null {
  const sel = new Set(itemIds);
  const items = ctx.page.items().filter((it) => sel.has(it.id));
  if (!items.length) return null;
  const seeds = items.map((it) => ctx.boxes.get(it.id) ?? itemBBox(it));
  const others = ctx.ink.filter((it) => !sel.has(it.id));
  const context = contextFor(seeds.filter((_, i) => isInk(items[i]!)), others.map((it) => ctx.boxes.get(it.id)!), ctx.unit).map((j) => others[j]!.id);
  let box: BBox | null = null;
  for (const b of seeds) box = unionBBox(box, b);
  for (const id of context) box = unionBBox(box, ctx.boxes.get(id)!);
  return { pageId: ctx.pageId, fresh: items.map((it) => it.id), context, erased: [], box: box! };
}

/**
 * Labels a region: the same strokes as one of this agent's current regions on the page keep that label; otherwise it
 * gets the next one and replaces this agent's current regions it overlaps (`was`). Ids are the ink it shows.
 */
export function registerRegion(regions: QinkRegions, r: { pageId: string; ids: string[]; box: BBox }, client?: string): { label: string; was: string[] } {
  const ids = [...new Set(r.ids)].sort();
  const key = ids.join(',');
  const mine = Object.entries(regions.byLabel).filter(([, x]) => x.pageId === r.pageId && !x.replaced && x.client === client);
  const same = ids.length ? mine.find(([, x]) => [...x.ids].sort().join(',') === key) : undefined;
  if (same) {
    same[1].box = r.box;
    same[1].at = Date.now();
    return { label: same[0], was: [] };
  }
  const idSet = new Set(ids);
  const was: string[] = [];
  for (const [label, x] of mine) {
    if (boxGap(x.box, r.box) > 0 && !x.ids.some((id) => idSet.has(id))) continue;
    x.replaced = true;
    was.push(label);
  }
  const label = `R${regions.next++}`;
  regions.byLabel[label] = { pageId: r.pageId, ids, box: r.box, ...(client !== undefined ? { client } : {}), at: Date.now() };
  pruneRegions(regions);
  return { label, was: was.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) };
}

/** Keeps the registry bounded: forgets the oldest replaced regions, then the oldest ones. */
function pruneRegions(regions: QinkRegions): void {
  const all = Object.entries(regions.byLabel);
  if (all.length <= MAX_REGIONS) return;
  const n = Number;
  all.sort(([la, a], [lb, b]) => Number(!a.replaced) - Number(!b.replaced) || n(la.slice(1)) - n(lb.slice(1)));
  for (const [label] of all.slice(0, all.length - MAX_REGIONS)) delete regions.byLabel[label];
}

class Rows {
  readonly rows: RegionRow[] = [];
  add(row: Omit<RegionRow, 'label'>): number {
    this.rows.push({ ...row, label: `[${this.rows.length + 1}]` });
    return this.rows.length;
  }
}

/** ` "a" / "b"` text of fresh readings covering all of `ids`, or null. */
function coverText(readings: readonly Reading[], ids: readonly string[]): string | null {
  const cover = freshCover(readings, ids);
  return cover ? cover.map((r) => r.text).join(' / ') : null;
}

/**
 * One region's line, and its image row unless fresh readings cover all its ink (then its text goes instead):
 * `R7 [1] p6 @120,300 260x80 +5 -1 (was R3,R4)` or `R7 p6 @120,300 260x80 "u = x^2"`.
 */
function regionLine(ctx: PageCtx, d: Draft, regions: QinkRegions, rows: Rows, opts: { client?: string; scale?: RegionRow['scale']; textOk: boolean }): string {
  const ids = [...d.fresh.filter((id) => ctx.boxes.has(id)), ...d.context];
  const { label, was } = registerRegion(regions, { pageId: ctx.pageId, ids, box: d.box }, opts.client);
  const place = `p${ctx.pos} ${gridPlace(d.box, ctx.info.size)}`;
  const text = opts.textOk && !d.erased.length ? coverText(ctx.page.readings(), ids) : null;
  if (text !== null) return `${label} ${place} ${quote(text)}`;
  const row = rows.add({ pageId: ctx.pageId, box: d.box, fresh: d.fresh, context: d.context, erased: d.erased, unit: ctx.unit, ...(opts.scale ? { scale: opts.scale } : {}) });
  const counts = d.first ? '' : `${d.fresh.length ? ` +${d.fresh.length}` : ''}${d.erased.length ? ` -${d.erased.length}` : ''}`;
  return `${label} [${row}] ${place}${counts}${was.length ? ` (was ${was.join(',')})` : ''}`;
}

/** The `p6@120,300,260,80` (or `p6`) a thread is about, live. */
function threadRef(ctx: { pos: number; info: PageInfo; page: Page }, c: Comment): string {
  const items = ctx.page.items();
  const box = anchorInkRemoved(c, items) ? null : threadBox(c, items);
  return box ? boxRef(ctx.pos, box, ctx.info.size) : `p${ctx.pos}`;
}

const isBox = (b: unknown): b is BBox => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x));

/** A finite, ordered box (asks come from clients). */
function cleanBox(b: BBox): BBox {
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

/**
 * An Ask as the encoder can use it, or null if it can't be used at all. Asks are client-written Yjs data, so
 * nothing about their shape is trusted: a bad `sel` or `commentId` is dropped, a missing `text` becomes ''.
 * `onBad` hears what was wrong (for the server's log).
 */
export function cleanAsk(raw: unknown, onBad?: (why: string) => void): QinkAsk | null {
  if (!raw || typeof raw !== 'object') {
    onBad?.('not an object');
    return null;
  }
  const a = raw as Record<string, unknown>;
  if (typeof a.pageId !== 'string' || !a.pageId) {
    onBad?.('no pageId');
    return null;
  }
  if (a.text !== undefined && typeof a.text !== 'string') onBad?.('text is not a string');
  const out: QinkAsk = { pageId: a.pageId, text: typeof a.text === 'string' ? a.text : '' };
  if (a.sel !== undefined) {
    const sel = a.sel as Record<string, unknown> | null;
    const itemIds = sel && typeof sel === 'object' ? sel.itemIds : undefined;
    if (Array.isArray(itemIds) && itemIds.every((x) => typeof x === 'string') && isBox(sel!.bbox)) out.sel = { itemIds, bbox: cleanBox(sel!.bbox) };
    else onBad?.('bad sel (dropped)');
  }
  if (typeof a.commentId === 'string' && a.commentId) out.commentId = a.commentId;
  else if (a.commentId !== undefined) onBad?.('bad commentId (dropped)');
  return out;
}

/**
 * Net diff of `pages` against what the agent last saw (`prev`: ink signatures per page), in the Q-ink Live v1.0 update
 * format (qink-live.md §2). Every changed stroke is in some region row of the one image (rows may come from several
 * pages). A page the agent has never seen gets a **first look**: all of its ink as regions, read ones as text.
 * `regions` (the label registry) is updated in place; `client` is the agent (labels' "was" lists are per agent).
 */
export function encodeQinkUpdate(
  nb: Notebook,
  pages: Record<string, Page>,
  regions: QinkRegions,
  prev: Record<string, InkSeen | undefined>,
  opts: { session: string; rev: number; client?: string; asks?: QinkAsk[]; threads?: QinkThreads; seen?: QinkSeen },
): { text: string; image: QinkImage | null; ink: Record<string, InkSeen>; seen: QinkSeen } {
  const threads = opts.threads ?? emptyThreads();
  const seen: QinkSeen = { ...opts.seen };
  // One malformed ask must never make the whole update throw (every later wait would fail too).
  const asks = (opts.asks ?? []).map((a) => cleanAsk(a)).filter((a): a is QinkAsk => !!a);
  const infos = nb.pages();
  const pos = new Map(infos.map((p, i) => [p.id, i + 1]));
  const ink: Record<string, InkSeen> = {};
  const rows = new Rows();
  const ctxs: (PageCtx & { first: boolean; drafts: Draft[] })[] = [];
  for (const pageId of Object.keys(pages).filter((id) => pos.has(id)).sort((a, b) => pos.get(a)! - pos.get(b)!)) {
    const page = pages[pageId]!;
    const ctx = pageCtx(page, pageId, pos.get(pageId)!, infos[pos.get(pageId)! - 1]!);
    const cur = pageInk(page);
    const before = prev[pageId];
    ink[pageId] = cur;
    if (!before) {
      ctxs.push({ ...ctx, first: true, drafts: firstLookRegions(ctx) });
      continue;
    }
    const fresh = Object.keys(cur).filter((id) => before[id] !== cur[id]);
    const erased = Object.keys(before).filter((id) => !(id in cur)).map((id) => sigPolyline(before[id]!));
    // A stroke the partial eraser shortened keeps its id: the agent sees what it was as erased, and what's left as new.
    for (const id of fresh) if (before[id] && shrank(sigPolyline(before[id]!), sigPolyline(cur[id]!))) erased.push(sigPolyline(before[id]!));
    ctxs.push({ ...ctx, first: false, drafts: changeRegions(ctx, fresh, erased) });
  }

  const askPage = asks.length ? asks[asks.length - 1]!.pageId : undefined;
  const changed = ctxs.filter((c) => c.drafts.length);
  const current = ctxs.find((c) => c.pageId === askPage) ?? changed[changed.length - 1] ?? ctxs[0];

  const out: string[] = [];
  out.push(`#q s=${opts.session} r=${opts.rev}${current ? ` p${current.pos} ${gridSize(current.info.size)}${current.first ? ' first look' : ''}` : ''}`);
  const ordered = current ? [current, ...changed.filter((c) => c !== current)] : changed;
  for (const c of ordered) {
    if (c !== current) out.push(`p${c.pos} ${gridSize(c.info.size)}${c.first ? ' first look' : ''}`);
    for (const d of c.drafts) out.push(regionLine(c, d, regions, rows, { client: opts.client, textOk: c.first, ...(c.first ? { scale: 'first' as const } : {}) }));
  }

  // An ask's thread is delivered as the ask; its first entry never comes back as a note.
  for (const a of asks) if (a.commentId) seen[a.commentId] = Math.max(seen[a.commentId] ?? 0, 1);

  // The student's new comments and replies, on every page in this update.
  for (const c of ctxs) {
    for (const cm of c.page.comments()) {
      const entries = [{ author: cm.author, text: cm.text }, ...cm.replies];
      if (c.first && seen[cm.id] === undefined) {
        // A page this agent has never had an update for: no replay of its history. Only the open threads, each with
        // its latest message; resolved ones are skipped. The whole thread is a `read` away (qink-live.md §2).
        seen[cm.id] = entries.length;
        if (cm.resolved) continue;
        const last = entries[entries.length - 1]!;
        out.push(`open ${threadLabel(threads, cm.id, c.pageId)} ${threadRef(c, cm)} ${who(last.author)} ${quote(clip(last.text))}`);
        continue;
      }
      const from = Math.max(seen[cm.id] ?? 0, cm.ask ? 1 : 0);
      for (let i = from; i < entries.length; i++) {
        const e = entries[i]!;
        if (e.author.kind !== 'user' || (i === 0 && cm.resolved)) continue;
        const label = threadLabel(threads, cm.id, c.pageId);
        out.push(i === 0 ? `note ${label} ${threadRef(c, cm)} ${quote(clip(e.text))}` : `re ${label} ${quote(clip(e.text))}`);
      }
      seen[cm.id] = Math.max(seen[cm.id] ?? 0, entries.length);
    }
  }

  for (const a of asks) {
    const parts = ['ask'];
    if (a.commentId) parts.push(threadLabel(threads, a.commentId, a.pageId));
    const c = ctxs.find((x) => x.pageId === a.pageId);
    if (a.sel && c) {
      // The selection (black) and the ink around it (grey), always as an image row: the student is asking about it.
      const d = selectionDraft(c, a.sel.itemIds);
      if (d) {
        const ids = [...d.fresh.filter((id) => c.boxes.has(id)), ...d.context];
        const { label } = registerRegion(regions, { pageId: c.pageId, ids, box: d.box }, opts.client);
        const row = rows.add({ pageId: c.pageId, box: d.box, fresh: d.fresh, context: d.context, erased: [], unit: c.unit });
        parts.push(`${label} [${row}] p${c.pos} ${gridPlace(d.box, c.info.size)}`);
      } else {
        // Nothing selected is left (or it was only a picture since deleted): a crop of the selected box.
        const row = rows.add({ pageId: c.pageId, box: a.sel.bbox, fresh: [], context: [], erased: [], unit: c.unit, clip: true });
        parts.push(`${boxRef(c.pos, a.sel.bbox, c.info.size)} [${row}]`);
      }
    } else if (a.sel && pos.has(a.pageId)) parts.push(`p${pos.get(a.pageId)}`);
    parts.push(quote(a.text));
    out.push(parts.join(' '));
  }

  return { text: out.join('\n'), image: rows.rows.length ? { rows: rows.rows } : null, ink, seen };
}

/** `read C5`: the whole thread, oldest entry first, each marked `student` or `agent`. */
export function encodeQinkThread(nb: Notebook, pages: Record<string, Page>, threads: QinkThreads, ref: string): string {
  const { pageId, commentId } = resolveThread(threads, ref);
  const label = threads.byId[commentId]!.label;
  const infos = nb.pages();
  const n = infos.findIndex((p) => p.id === pageId) + 1;
  const page = pages[pageId];
  if (!n) throw new Error(`Thread ${label} was on a deleted page`);
  if (!page) throw new Error(`Page p${n} is not loaded`);
  const c = page.comments().find((x) => x.id === commentId);
  if (!c) throw new Error(`Thread ${label} was deleted`);
  const out = [`#q ${label} ${threadRef({ pos: n, info: infos[n - 1]!, page }, c)}${c.resolved ? ' resolved' : ''}`];
  for (const e of [{ author: c.author, text: c.text }, ...c.replies]) out.push(`${who(e.author)} ${quote(clip(e.text))}`);
  return out.join('\n');
}

// ---- refs ----

/** What a ref names: a region `R7`, a box `p6@120,300,260,80` or a page `p6`. */
export type QinkTarget =
  | { kind: 'region'; label: string; pageId: string; pos: number; ids: string[]; box: BBox }
  | { kind: 'box'; pageId: string; pos: number; box: BBox }
  | { kind: 'page'; pageId: string; pos: number };

const BOX_REF = /^p(\d+)@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/i;

function pageAt(nb: Notebook, n: number): PageInfo {
  const info = nb.pages()[n - 1];
  if (!info) throw new Error(`No page p${n}`);
  return info;
}

/** Resolves `R7`, `p6@120,300,260,80` or `p6` (for read, transcribe and comment). */
export function resolveTarget(nb: Notebook, regions: QinkRegions, ref: string): QinkTarget {
  const r = ref.trim().replace(/\s+/g, '');
  const rm = /^r(\d+)$/i.exec(r);
  if (rm) {
    const label = `R${rm[1]}`;
    const hit = regions.byLabel[label];
    if (!hit) throw new Error(rm[1] && Number(rm[1]) < regions.next ? `${label} is too old; read the page (e.g. "p3") for current regions` : `No region ${label}`);
    const pos = nb.pages().findIndex((p) => p.id === hit.pageId) + 1;
    if (!pos) throw new Error(`${label} was on a deleted page`);
    return { kind: 'region', label, pageId: hit.pageId, pos, ids: hit.ids, box: hit.box };
  }
  const bm = BOX_REF.exec(r);
  if (bm) {
    const pos = Number(bm[1]);
    const info = pageAt(nb, pos);
    const g = [Number(bm[2]), Number(bm[3]), Number(bm[4]), Number(bm[5])] as [number, number, number, number];
    if (g[2] <= 0 || g[3] <= 0) throw new Error(`Empty box: ${ref}`);
    return { kind: 'box', pageId: info.id, pos, box: fromGrid(g, info.size) };
  }
  const pm = /^p(\d+)$/i.exec(r);
  if (pm) {
    const pos = Number(pm[1]);
    return { kind: 'page', pageId: pageAt(nb, pos).id, pos };
  }
  throw new Error(`Bad ref: ${ref} (expected a region "R7", a box "p6@120,300,260,80" or a page "p6")`);
}

/** The ink a box is about: strokes and shapes whose centre is inside it. */
export function inkInBox(items: readonly Item[], box: BBox): string[] {
  return items
    .filter((it) => {
      if (!isInk(it)) return false;
      const b = itemBBox(it);
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
    })
    .map((it) => it.id);
}

/**
 * Reads on demand: `outline`, a page `p3` (all its ink as regions, read ones as text), a region `R7` (its strokes now,
 * with any reading of them), a box `p3@120,300,260,80` (a crop of everything in it) or `pdf:p2` (the PDF behind page 2).
 */
export function encodeQinkRead(
  nb: Notebook,
  pages: Record<string, Page>,
  regions: QinkRegions,
  ref: string,
  client?: string,
): { text: string; image: QinkImage | null } {
  const infos = nb.pages();
  if (ref.trim() === 'outline') {
    const out = [`#q outline ${quote(nb.meta().title ?? '')}`];
    infos.forEach((info, i) => {
      const page = pages[info.id];
      const first = page ? sortReading(page.readings().filter((r) => !r.stale).map((r) => ({ r, box: readingBox(page, r) ?? ([0, 0, 0, 0] as BBox) })))[0] : undefined;
      out.push(`p${i + 1} ${gridSize(info.size)}${info.background.kind === 'pdf' ? ' pdf' : ''}${first ? ` ${quote(first.r.text)}` : ''}`);
    });
    return { text: out.join('\n'), image: null };
  }

  const pdf = /^pdf:p(\d+)$/i.exec(ref.trim());
  if (pdf) {
    const n = Number(pdf[1]);
    const bg = pageAt(nb, n).background;
    if (bg.kind !== 'pdf') throw new Error(`p${n} has no PDF background`);
    const name = nb.assets().find((a) => a.id === bg.assetId)?.name ?? bg.assetId;
    return { text: `#q pdf:p${n} ${quote(name)} page=${bg.pageIndex + 1}`, image: null };
  }

  const t = resolveTarget(nb, regions, ref);
  const info = infos[t.pos - 1]!;
  const page = pages[t.pageId];
  if (!page) throw new Error(`Page p${t.pos} is not loaded`);
  const ctx = pageCtx(page, t.pageId, t.pos, info);
  const rows = new Rows();
  if (t.kind === 'page') {
    const out = [`#q p${t.pos} ${gridSize(info.size)}`];
    for (const d of firstLookRegions(ctx)) out.push(regionLine(ctx, d, regions, rows, { client, textOk: true, scale: 'read' }));
    if (out.length === 1) out.push('(no ink)');
    return { text: out.join('\n'), image: rows.rows.length ? { rows: rows.rows } : null };
  }
  if (t.kind === 'box') {
    const row = rows.add({ pageId: t.pageId, box: t.box, fresh: [], context: [], erased: [], unit: ctx.unit, clip: true, scale: 'read' });
    return { text: `#q ${boxRef(t.pos, t.box, info.size)} [${row}]`, image: { rows: rows.rows } };
  }
  const live = t.ids.filter((id) => ctx.boxes.has(id));
  if (!live.length) throw new Error(`${t.label}'s ink was erased; read the page (p${t.pos}) for what is there now`);
  let box: BBox | null = null;
  for (const id of live) box = unionBBox(box, ctx.boxes.get(id)!);
  const row = rows.add({ pageId: t.pageId, box: box!, fresh: live, context: [], erased: [], unit: ctx.unit, scale: 'read' });
  const out = [`#q ${t.label} [${row}] p${t.pos} ${gridPlace(box!, info.size)}`];
  for (const r of readingsOf(page.readings(), live)) out.push(`${r.src === 'user' ? 'student' : 'agent'}${r.stale ? ' stale' : ''} ${quote(r.text)}`);
  return { text: out.join('\n'), image: { rows: rows.rows } };
}

function readingBox(page: Page, r: Reading): BBox | null {
  let bb: BBox | null = null;
  for (const id of r.ids) {
    const it = page.item(id);
    if (it) bb = unionBBox(bb, itemBBox(it));
  }
  return bb;
}
