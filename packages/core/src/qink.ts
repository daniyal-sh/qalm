import type { Notebook } from './model/notebook';
import type { Page } from './model/page';
import { intersects } from './geometry/bbox';
import type { Ask, BBox, Comment, Line } from './types';

/** Short labels per page. Stored by the server (notebook DocRoom), never in Yjs. */
export interface QinkLabels { [pageId: string]: { nextL: number; nextD: number; byKey: Record<string, string> } }
/** What an agent session last saw: per page, line key -> hash of itemIds + text. */
export interface QinkSnapshot { [pageId: string]: Record<string, string> }
/** Rows to render with `renderLinesStripSvg(page, lineKeys, labels)`: line keys, or a page box for a crop row. */
export interface QinkImage { pageId: string; lineKeys: (string | BBox)[]; labels: string[] }
/** Short thread labels (`C1`, `C2`, …), notebook-wide and never reused. Stored by the server, never in Yjs. */
export interface QinkThreads { next: number; byId: Record<string, { label: string; pageId: string }> }
/** What one agent has seen of each thread: comment id -> number of entries (the comment plus its replies). */
export type QinkSeen = Record<string, number>;
/** An Ask as the encoder needs it. */
export type QinkAsk = Pick<Ask, 'pageId' | 'text' | 'sel' | 'commentId'>;

export const emptyThreads = (): QinkThreads => ({ next: 1, byId: {} });

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

/** Top to bottom, then left to right. */
function readingOrder(a: Line, b: Line): number {
  return a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Gives every unlabelled line the next number (in reading order). Existing labels never change. */
export function assignLabels(labels: QinkLabels, pageId: string, lines: Line[]): void {
  const p = (labels[pageId] ??= { nextL: 1, nextD: 1, byKey: {} });
  for (const l of [...lines].sort(readingOrder)) {
    if (p.byKey[l.key]) continue;
    p.byKey[l.key] = l.kind === 'drawing' ? `D${p.nextD++}` : `L${p.nextL++}`;
  }
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length.toString(36)}.${h.toString(36)}`;
}

const lineHash = (l: Line) => hash(`${l.itemIds.join(',')}\n${l.text ?? ''}`);

/** Lines without text, or with only the device's guess, are sent as an image. */
const needsImage = (l: Line) => l.text === undefined || l.textSrc === 'device';

/** Everything after the label: ` "trusted"`, or ` [n] ~"guess"`. */
function body(l: Line, row: number | undefined): string {
  if (!needsImage(l)) return ` ${quote(l.text!)}`;
  return (row !== undefined ? ` [${row}]` : '') + (l.text !== undefined ? ` ~${quote(l.text)}` : '');
}

/** ` "text"` of the page's first line that has text, or ''. */
function title(sorted: Line[]): string {
  const first = sorted.find((l) => l.kind === 'line' && l.text);
  return first ? ` ${quote(first.text!)}` : '';
}

function labelOrder(a: string, b: string): number {
  return a[0] !== b[0] ? (a[0] === 'L' ? -1 : 1) : Number(a.slice(1)) - Number(b.slice(1));
}

/** `L4-6,D1`: labels in label order, consecutive numbers of the same kind folded into ranges. */
export function labelList(labels: string[]): string {
  const sorted = [...new Set(labels)].sort(labelOrder);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    const k = sorted[i]![0]!;
    const lo = Number(sorted[i]!.slice(1));
    let hi = lo;
    let j = i + 1;
    while (j < sorted.length && sorted[j]![0] === k && Number(sorted[j]!.slice(1)) === hi + 1) hi = Number(sorted[j++]!.slice(1));
    out.push(hi > lo ? `${k}${lo}-${hi}` : `${k}${lo}`);
    i = j;
  }
  return out.join(',');
}

/** The lines a selection touches, and whether it is exactly those whole lines (otherwise it gets a crop row). */
function selectionLines(sorted: Line[], itemIds: string[]): { lines: Line[]; aligned: boolean } {
  const ids = new Set(itemIds);
  const lines = sorted.filter((l) => l.itemIds.some((id) => ids.has(id)));
  const covered = new Set(lines.flatMap((l) => l.itemIds));
  const aligned = lines.length > 0 && lines.every((l) => l.itemIds.every((id) => ids.has(id))) && itemIds.every((id) => covered.has(id));
  return { lines, aligned };
}

/** The `p3:L4` (or `p3:L4-6`, or `p3`) a thread is about. */
function threadRef(pos: number, c: Comment, sorted: Line[], byKey: Record<string, string>): string {
  let keys = c.lineKey && byKey[c.lineKey] ? [c.lineKey] : [];
  if (c.anchor) {
    const box = c.anchor;
    const inBox = sorted.filter((l) => intersects(l.bbox, box)).map((l) => l.key);
    if (inBox.length) keys = inBox;
  }
  const labels = keys.map((k) => byKey[k]).filter((x): x is string => !!x);
  return labels.length ? `p${pos}:${labelList(labels)}` : `p${pos}`;
}

/** A row for a line that is in the image whatever its text: ` [n]`, then ` "trusted"` or ` ~"guess"`. */
function rowBody(l: Line, row: number): string {
  if (l.text === undefined) return ` [${row}]`;
  return ` [${row}] ${needsImage(l) ? '~' : ''}${quote(l.text)}`;
}

/** A finite, ordered box (asks come from clients). */
function cleanBox(b: BBox): BBox {
  const v = b.map((x) => (Number.isFinite(x) ? x : 0));
  return [Math.min(v[0]!, v[2]!), Math.min(v[1]!, v[3]!), Math.max(v[0]!, v[2]!), Math.max(v[1]!, v[3]!)];
}

class Rows {
  readonly keys: (string | BBox)[] = [];
  readonly labels: string[] = [];
  add(key: string | BBox): number {
    this.keys.push(key);
    this.labels.push(`[${this.keys.length}]`);
    return this.keys.length;
  }
}

interface Section { pageId: string; pos: number; sorted: Line[]; changed: Line[]; added: Set<string>; removed: string[] }

/**
 * Net diff of `pages` against `prev`, in the Q-ink Live update format (qink-live.md §2).
 *
 * The header names the current page: the page of the last ask if it was passed in, otherwise the last changed page.
 * Its changed lines that need an image get `[n]` rows. Other changed pages follow under a `pN "title"` line;
 * their lines carry only the device guess (one image per update), and the agent can `read` them.
 */
export function encodeQinkUpdate(
  nb: Notebook,
  pages: Record<string, Page>,
  labels: QinkLabels,
  prev: QinkSnapshot,
  opts: { session: string; rev: number; asks?: QinkAsk[]; threads?: QinkThreads; seen?: QinkSeen },
): { text: string; image: QinkImage | null; snapshot: QinkSnapshot; seen: QinkSeen } {
  const threads = opts.threads ?? emptyThreads();
  const seen: QinkSeen = { ...opts.seen };
  const pos = new Map(nb.pages().map((p, i) => [p.id, i + 1]));
  const snapshot: QinkSnapshot = { ...prev };
  const all: Section[] = [];
  for (const pageId of Object.keys(pages).filter((id) => pos.has(id)).sort((a, b) => pos.get(a)! - pos.get(b)!)) {
    const lines = pages[pageId]!.lines();
    assignLabels(labels, pageId, lines);
    const sorted = [...lines].sort(readingOrder);
    const cur: Record<string, string> = {};
    for (const l of sorted) cur[l.key] = lineHash(l);
    const before = prev[pageId] ?? {};
    const byKey = labels[pageId]!.byKey;
    all.push({
      pageId,
      pos: pos.get(pageId)!,
      sorted,
      changed: sorted.filter((l) => before[l.key] !== cur[l.key]),
      added: new Set(sorted.filter((l) => !(l.key in before)).map((l) => l.key)),
      removed: Object.keys(before)
        .filter((k) => !(k in cur) && byKey[k])
        .map((k) => byKey[k]!)
        .sort(labelOrder),
    });
    snapshot[pageId] = cur;
  }

  const changedSections = all.filter((s) => s.changed.length || s.removed.length);
  const askPage = opts.asks?.length ? opts.asks[opts.asks.length - 1]!.pageId : undefined;
  const current = all.find((s) => s.pageId === askPage) ?? changedSections[changedSections.length - 1] ?? all[0];

  // Selection asks on the current page: their lines always go into the image (even unchanged or trusted ones).
  const asks = opts.asks ?? [];
  const selected = new Set<string>();
  if (current) {
    for (const a of asks) {
      if (a.pageId !== current.pageId || !a.sel) continue;
      for (const l of selectionLines(current.sorted, a.sel.itemIds).lines) selected.add(l.key);
    }
  }

  const out: string[] = [];
  const rows = new Rows();
  const diff = (s: Section, image: boolean) => {
    const byKey = labels[s.pageId]!.byKey;
    const first = s.changed[0];
    if (first) {
      const i = s.sorted.indexOf(first);
      const ctx = s.sorted.slice(0, i).reverse().find((l) => l.kind === 'line');
      if (ctx && !(image && selected.has(ctx.key))) out.push(` ${byKey[ctx.key]}${ctx.text ? ` ${ctx.text}` : ''}`);
    }
    for (const l of s.changed) {
      const forced = image && selected.has(l.key);
      const row = image && (needsImage(l) || forced) ? rows.add(l.key) : undefined;
      out.push(`${s.added.has(l.key) ? '+' : '~'}${byKey[l.key]}${forced ? rowBody(l, row!) : body(l, row)}`);
    }
    for (const label of s.removed) out.push(`-${label}`);
    if (!image) return;
    // Selected lines that didn't change, so the agent sees what the question is about.
    const changed = new Set(s.changed.map((l) => l.key));
    for (const l of s.sorted) if (selected.has(l.key) && !changed.has(l.key)) out.push(` ${byKey[l.key]}${rowBody(l, rows.add(l.key))}`);
  };

  out.push(`#q s=${opts.session} r=${opts.rev}${current ? ` p${current.pos}${title(current.sorted)}` : ''}`);
  if (current) diff(current, true);
  for (const s of changedSections) {
    if (s === current) continue;
    out.push(`p${s.pos}${title(s.sorted)}`);
    diff(s, false);
  }

  // An ask's thread is delivered as the ask; its first entry never comes back as a note.
  for (const a of asks) if (a.commentId) seen[a.commentId] = Math.max(seen[a.commentId] ?? 0, 1);

  // The student's new comments and replies, on every page in this update.
  for (const s of all) {
    const byKey = labels[s.pageId]!.byKey;
    for (const c of pages[s.pageId]!.comments()) {
      const entries = [{ author: c.author, text: c.text }, ...c.replies];
      const from = Math.max(seen[c.id] ?? 0, c.ask ? 1 : 0);
      for (let i = from; i < entries.length; i++) {
        const e = entries[i]!;
        if (e.author.kind !== 'user' || (i === 0 && c.resolved)) continue;
        const label = threadLabel(threads, c.id, s.pageId);
        out.push(i === 0 ? `note ${label} ${threadRef(s.pos, c, s.sorted, byKey)} ${quote(clip(e.text))}` : `re ${label} ${quote(clip(e.text))}`);
      }
      seen[c.id] = Math.max(seen[c.id] ?? 0, entries.length);
    }
  }

  for (const a of asks) {
    const parts = ['ask'];
    if (a.commentId) parts.push(threadLabel(threads, a.commentId, a.pageId));
    const p = pos.get(a.pageId);
    if (a.sel && p !== undefined) {
      const sec = all.find((x) => x.pageId === a.pageId);
      const sl = sec ? selectionLines(sec.sorted, a.sel.itemIds) : { lines: [], aligned: false };
      const byKey = labels[a.pageId]?.byKey ?? {};
      const ls = sl.lines.map((l) => byKey[l.key]).filter((x): x is string => !!x);
      parts.push(ls.length ? `p${p}:${labelList(ls)}` : `p${p}`);
      // Not whole lines (part of a line, a text box, a picture): the selected region goes in as its own row.
      if (sec && sec === current && !sl.aligned) parts.push(`[${rows.add(cleanBox(a.sel.bbox))}]`);
    }
    parts.push(quote(a.text));
    out.push(parts.join(' '));
  }

  return {
    text: out.join('\n'),
    image: current && rows.keys.length ? { pageId: current.pageId, lineKeys: rows.keys, labels: rows.labels } : null,
    snapshot,
    seen,
  };
}

const PAGE_REF = /^p(\d+)(?::([LD])(\d+)(?:-[LD]?(\d+))?)?$/;

function pageAt(nb: Notebook, n: number) {
  const info = nb.pages()[n - 1];
  if (!info) throw new Error(`No page p${n}`);
  return info;
}

/**
 * Reads on demand: `outline`, `p3`, `p3:L2-9` (labels L2 to L9) or `pdf:p2` (the PDF behind page 2).
 * Page reads list every line; lines without trusted text go into the image.
 */
export function encodeQinkRead(
  nb: Notebook,
  pages: Record<string, Page>,
  labels: QinkLabels,
  ref: string,
): { text: string; image: QinkImage | null } {
  const infos = nb.pages();
  if (ref === 'outline') {
    const out = [`#q outline ${quote(nb.meta().title ?? '')}`];
    infos.forEach((info, i) => {
      const page = pages[info.id];
      const t = page ? title([...page.lines()].sort(readingOrder)) : '';
      out.push(`p${i + 1}${info.background.kind === 'pdf' ? ' pdf' : ''}${t}`);
    });
    return { text: out.join('\n'), image: null };
  }

  const pdf = /^pdf:p(\d+)$/.exec(ref);
  if (pdf) {
    const n = Number(pdf[1]);
    const bg = pageAt(nb, n).background;
    if (bg.kind !== 'pdf') throw new Error(`p${n} has no PDF background`);
    const name = nb.assets().find((a) => a.id === bg.assetId)?.name ?? bg.assetId;
    return { text: `#q pdf:p${n} ${quote(name)} page=${bg.pageIndex + 1}`, image: null };
  }

  const m = PAGE_REF.exec(ref);
  if (!m) throw new Error(`Bad ref: ${ref}`);
  const n = Number(m[1]);
  const info = pageAt(nb, n);
  const page = pages[info.id];
  if (!page) throw new Error(`Page p${n} is not loaded`);
  const lines = page.lines();
  assignLabels(labels, info.id, lines);
  const byKey = labels[info.id]!.byKey;
  const sorted = [...lines].sort(readingOrder);
  let picked = sorted;
  if (m[2]) {
    const lo = Number(m[3]);
    const hi = m[4] ? Number(m[4]) : lo;
    picked = sorted.filter((l) => {
      const label = byKey[l.key]!;
      const k = Number(label.slice(1));
      return label[0] === m[2] && k >= lo && k <= hi;
    });
  }
  const rows = new Rows();
  const out = [`#q p${n}${title(sorted)}`];
  for (const l of picked) out.push(` ${byKey[l.key]}${body(l, needsImage(l) ? rows.add(l.key) : undefined)}`);
  return { text: out.join('\n'), image: rows.keys.length ? { pageId: info.id, lineKeys: rows.keys, labels: rows.labels } : null };
}

/** Resolves `p3:L4` (or `p3:D1`) to a page id and line key, for `transcribe` and `comment`. */
export function resolveRef(labels: QinkLabels, nb: Notebook, ref: string): { pageId: string; lineKey: string } {
  const m = /^p(\d+):([LD]\d+)$/.exec(ref);
  if (!m) throw new Error(`Bad line ref: ${ref}`);
  const pageId = pageAt(nb, Number(m[1])).id;
  const hit = Object.entries(labels[pageId]?.byKey ?? {}).find(([, label]) => label === m[2]);
  if (!hit) throw new Error(`No line ${m[2]} on p${m[1]}`);
  return { pageId, lineKey: hit[0] };
}
