import type { Notebook } from './model/notebook';
import type { Page } from './model/page';
import type { Ask, Line } from './types';

/** Short labels per page. Stored by the server (notebook DocRoom), never in Yjs. */
export interface QinkLabels { [pageId: string]: { nextL: number; nextD: number; byKey: Record<string, string> } }
/** What an agent session last saw: per page, line key -> hash of itemIds + text. */
export interface QinkSnapshot { [pageId: string]: Record<string, string> }
/** Lines to render with `renderLinesStripSvg(page, lineKeys, labels)`. */
export interface QinkImage { pageId: string; lineKeys: string[]; labels: string[] }

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

class Rows {
  readonly keys: string[] = [];
  readonly labels: string[] = [];
  add(key: string): number {
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
  opts: { session: string; rev: number; asks?: Pick<Ask, 'pageId' | 'text'>[] },
): { text: string; image: QinkImage | null; snapshot: QinkSnapshot } {
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

  const out: string[] = [];
  const rows = new Rows();
  const diff = (s: Section, image: boolean) => {
    const byKey = labels[s.pageId]!.byKey;
    const first = s.changed[0];
    if (first) {
      const i = s.sorted.indexOf(first);
      const ctx = s.sorted.slice(0, i).reverse().find((l) => l.kind === 'line');
      if (ctx) out.push(` ${byKey[ctx.key]}${ctx.text ? ` ${ctx.text}` : ''}`);
    }
    for (const l of s.changed) {
      const row = image && needsImage(l) ? rows.add(l.key) : undefined;
      out.push(`${s.added.has(l.key) ? '+' : '~'}${byKey[l.key]}${body(l, row)}`);
    }
    for (const label of s.removed) out.push(`-${label}`);
  };

  out.push(`#q s=${opts.session} r=${opts.rev}${current ? ` p${current.pos}${title(current.sorted)}` : ''}`);
  if (current) diff(current, true);
  for (const s of changedSections) {
    if (s === current) continue;
    out.push(`p${s.pos}${title(s.sorted)}`);
    diff(s, false);
  }
  for (const a of opts.asks ?? []) out.push(`ask ${quote(a.text)}`);

  return {
    text: out.join('\n'),
    image: current && rows.keys.length ? { pageId: current.pageId, lineKeys: rows.keys, labels: rows.labels } : null,
    snapshot,
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
