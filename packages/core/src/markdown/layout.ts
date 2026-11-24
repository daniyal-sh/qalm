import { TEXT_LINE_HEIGHT } from '../geometry/textConstants';
import { fontRuns, textWidth, type MdFont } from './fonts';
import { texToPath } from './math';
import { parseMarkdown, type Marks, type MdBlock, type MdInline } from './parse';

/**
 * Lays out a Markdown text box into draw ops in box-local units (x right, y down from the top-left corner), measured
 * with the real fonts' advances (`fonts.ts`). Skia (the page), pdf-lib (PDF export) and SVG (agents' crops) only draw
 * these ops, so the three look and wrap the same. Every op is in the box's colour; `alpha` makes tints.
 */
export type MdOp =
  /** A run of text in one font; `y` is its baseline. */
  | { k: 'text'; x: number; y: number; text: string; font: MdFont; size: number }
  /** A filled rectangle: code backgrounds, quote bars, rules, underlines and strike-throughs. */
  | { k: 'rect'; x: number; y: number; w: number; h: number; alpha: number }
  /** Maths outlines: `d` (`MathBox.path`, 1/1000 em, y down) scaled by `s` and placed with its baseline at (x, y). */
  | { k: 'path'; x: number; y: number; s: number; d: string };

export interface MdLayout {
  ops: MdOp[];
  height: number;
}

/** Heading sizes, as multiples of the box's font size (h1 … h6). */
const HEADING = [1.5, 1.3, 1.15, 1, 1, 1];
const BLOCK_GAP = 0.5;
const ITEM_GAP = 0.15;
const CODE_SCALE = 0.9;
const TINT = 0.1;
/** TeX's Computer Modern is smaller than Figtree at the same size: maths is drawn this much larger to match. */
const MATH_SCALE = 1.15;

const markFont = (m: Marks, bold: boolean): MdFont => {
  if (m.code) return 'm';
  const b = bold || !!m.b;
  return b && m.i ? 'bi' : b ? 'b' : m.i ? 'i' : 'r';
};

/** A piece of a line: a word (or part), a space, or maths. Breaks only happen at spaces and line breaks. */
interface Piece {
  kind: 'word' | 'space' | 'math';
  w: number;
  /** Above and below the baseline. */
  a: number;
  d: number;
  m: Marks;
  text?: string;
  font?: MdFont;
  size?: number;
  /** Code spans' padding on each side. */
  pad?: number;
  math?: { d: string; s: number };
}

function wordPiece(text: string, m: Marks, font: MdFont, size: number): Piece {
  const pad = m.code ? size * 0.2 : 0;
  return { kind: 'word', text, m, font, size, pad, w: textWidth(text, font, size) + 2 * pad, a: size, d: size * (TEXT_LINE_HEIGHT - 1) };
}

/** Splits inline content into pieces, with `null` at hard line breaks. */
function pieces(c: readonly MdInline[], size: number, bold: boolean): (Piece | null)[] {
  const out: (Piece | null)[] = [];
  for (const x of c) {
    if (x.t === 'br') out.push(null);
    else if (x.t === 'math') {
      const box = texToPath(x.tex, false);
      if (box) {
        const z = size * MATH_SCALE;
        out.push({ kind: 'math', m: x.m, w: box.w * z, a: Math.max(size, box.a * z + 0.15 * size), d: Math.max(size * (TEXT_LINE_HEIGHT - 1), box.d * z + 0.1 * size), math: { d: box.path, s: z / 1000 } });
      } else out.push(wordPiece(`$${x.tex}$`, { ...x.m, code: true }, 'm', size * CODE_SCALE));
    } else {
      const font = markFont(x.m, bold);
      const z = x.m.code ? size * CODE_SCALE : size;
      for (const part of x.text.split(/( +)/)) {
        if (!part) continue;
        if (part.startsWith(' ') && !x.m.code) out.push({ kind: 'space', m: x.m, w: textWidth(part, font, z), a: 0, d: 0, text: part, font, size: z });
        else out.push(wordPiece(part, x.m, font, z));
      }
    }
  }
  return out;
}

/** Breaks a word too wide for a whole line into pieces that fit. */
function splitWord(p: Piece, max: number): Piece[] {
  const out: Piece[] = [];
  let cur = '';
  for (const ch of p.text!) {
    if (cur && textWidth(cur + ch, p.font!, p.size!) + 2 * (p.pad ?? 0) > max) {
      out.push(wordPiece(cur, p.m, p.font!, p.size!));
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(wordPiece(cur, p.m, p.font!, p.size!));
  return out;
}

/** Greedy line breaking at spaces; words wider than a line are split. */
function lines(ps: readonly (Piece | null)[], width: number): Piece[][] {
  const out: Piece[][] = [];
  let line: Piece[] = [];
  let lineW = 0;
  const push = () => {
    while (line.length && line[line.length - 1]!.kind === 'space') line.pop();
    out.push(line);
    line = [];
    lineW = 0;
  };
  // Words with no space between them (`**a**b`) can't be broken apart: group them.
  const groups: (Piece[] | null)[] = [];
  for (const p of ps) {
    const last = groups[groups.length - 1];
    if (p === null) groups.push(null);
    else if (p.kind === 'space') groups.push([p]);
    else if (last && last[0]!.kind !== 'space') last.push(p);
    else groups.push([p]);
  }
  for (const g of groups) {
    if (g === null) {
      push();
      continue;
    }
    if (g[0]!.kind === 'space') {
      if (line.length) {
        line.push(g[0]!);
        lineW += g[0]!.w;
      }
      continue;
    }
    const gw = g.reduce((s, p) => s + p.w, 0);
    if (line.length && lineW + gw > width) push();
    if (gw <= width || line.length) {
      line.push(...g);
      lineW += gw;
      continue;
    }
    // Wider than a whole line: place piece by piece, splitting words.
    for (const p of g) {
      const parts = p.kind === 'word' && p.w > width ? splitWord(p, width) : [p];
      for (const q of parts) {
        if (line.length && lineW + q.w > width) push();
        line.push(q);
        lineW += q.w;
      }
    }
  }
  if (line.length || !out.length) push();
  return out;
}

interface Ctx {
  ops: MdOp[];
}

/** Lays out inline content at (x, y) in `width`; returns the height used. */
function flow(ctx: Ctx, c: readonly MdInline[], x: number, y: number, width: number, size: number, bold: boolean, center = false): number {
  let top = y;
  for (const line of lines(pieces(c, size, bold), width)) {
    const a = Math.max(size, ...line.map((p) => p.a));
    const d = Math.max(size * (TEXT_LINE_HEIGHT - 1), ...line.map((p) => p.d));
    const base = top + a;
    const lineW = line.reduce((s, p) => s + p.w, 0);
    let px = center ? x + Math.max(0, (width - lineW) / 2) : x;
    // Consecutive words and spaces in one font and size are one text op.
    let run: { x: number; text: string; font: MdFont; size: number } | null = null;
    const flush = () => {
      if (run?.text.trim()) {
        let rx = run.x;
        for (const r of fontRuns(run.text, run.font)) {
          ctx.ops.push({ k: 'text', x: rx, y: base, text: r.text, font: r.font, size: run.size });
          rx += textWidth(r.text, r.font, run.size);
        }
      }
      run = null;
    };
    line.forEach((p, i) => {
      if (p.kind === 'math') {
        flush();
        ctx.ops.push({ k: 'path', x: px, y: base, s: p.math!.s, d: p.math!.d });
      } else if (p.pad) {
        flush();
        const z = p.size!;
        ctx.ops.push({ k: 'rect', x: px, y: base - z * 0.95, w: p.w, h: z * 1.25, alpha: TINT });
        ctx.ops.push({ k: 'text', x: px + p.pad, y: base, text: p.text!, font: p.font!, size: z });
      } else if (run && run.font === p.font && run.size === p.size) run.text += p.text!;
      else {
        flush();
        run = { x: px, text: p.text!, font: p.font!, size: p.size! };
      }
      // Strike-through and link underline, across the spaces between struck or linked words too.
      const z = p.size ?? size;
      const inside = p.kind !== 'space' || (i > 0 && i < line.length - 1);
      if (p.m.s && inside) ctx.ops.push({ k: 'rect', x: px, y: base - z * 0.3, w: p.w, h: Math.max(0.5, z * 0.06), alpha: 1 });
      if (p.m.href && inside) ctx.ops.push({ k: 'rect', x: px, y: base + z * 0.12, w: p.w, h: Math.max(0.5, z * 0.05), alpha: 1 });
      px += p.w;
    });
    flush();
    top = base + d;
  }
  return top - y;
}

/** Lays out blocks at (x, y) in `width`; returns the height used. */
function layBlocks(ctx: Ctx, bs: readonly MdBlock[], x: number, y: number, width: number, S: number, depth: number, gap = BLOCK_GAP): number {
  let top = y;
  bs.forEach((b, k) => {
    if (k > 0) top += gap * S;
    top += layBlock(ctx, b, x, top, width, S, depth);
  });
  return top - y;
}

function layBlock(ctx: Ctx, b: MdBlock, x: number, y: number, width: number, S: number, depth: number): number {
  switch (b.t) {
    case 'p':
      return flow(ctx, b.c, x, y, width, S, false);
    case 'h':
      return flow(ctx, b.c, x, y, width, S * (HEADING[b.level - 1] ?? 1), true);
    case 'quote': {
      const inset = S * 0.8;
      const h = Math.max(S * TEXT_LINE_HEIGHT, layBlocks(ctx, b.c, x + inset, y, Math.max(1, width - inset), S, depth));
      ctx.ops.push({ k: 'rect', x, y, w: Math.max(1, S * 0.15), h, alpha: 0.35 });
      return h;
    }
    case 'list': {
      const indent = S * 1.5;
      let top = y;
      b.items.forEach((item, k) => {
        if (k > 0) top += ITEM_GAP * S;
        const marker = b.ordered ? `${b.start + k}.` : depth % 2 ? '–' : '•';
        const mw = textWidth(marker, 'r', S);
        ctx.ops.push({ k: 'text', x: b.ordered ? x + indent - S * 0.35 - mw : x + indent * 0.35, y: top + S, text: marker, font: 'r', size: S });
        top += Math.max(S * TEXT_LINE_HEIGHT, layBlocks(ctx, item, x + indent, top, Math.max(1, width - indent), S, depth + 1, ITEM_GAP));
      });
      return top - y;
    }
    case 'code': {
      const z = S * CODE_SCALE;
      const pad = S * 0.5;
      const rows: string[] = [];
      for (const row of b.text.split('\n')) {
        let cur = '';
        for (const ch of row) {
          if (cur && textWidth(cur + ch, 'm', z) > width - 2 * pad) {
            rows.push(cur);
            cur = ch;
          } else cur += ch;
        }
        rows.push(cur);
      }
      const lh = z * TEXT_LINE_HEIGHT;
      const h = rows.length * lh + 2 * pad;
      ctx.ops.push({ k: 'rect', x, y, w: width, h, alpha: TINT * 0.8 });
      rows.forEach((row, i) => {
        if (!row.trim()) return;
        let rx = x + pad;
        for (const r of fontRuns(row, 'm')) {
          ctx.ops.push({ k: 'text', x: rx, y: y + pad + i * lh + z, text: r.text, font: r.font, size: z });
          rx += textWidth(r.text, r.font, z);
        }
      });
      return h;
    }
    case 'math': {
      const box = texToPath(b.tex, true);
      if (!box) return layBlock(ctx, { t: 'code', text: `$$${b.tex}$$` }, x, y, width, S, depth);
      // Too wide: shrink to fit the box.
      const z = Math.min(S * MATH_SCALE, box.w > 0 ? width / box.w : S);
      const pad = S * 0.25;
      ctx.ops.push({ k: 'path', x: x + Math.max(0, (width - box.w * z) / 2), y: y + pad + box.a * z, s: z / 1000, d: box.path });
      return (box.a + box.d) * z + 2 * pad;
    }
    case 'hr': {
      ctx.ops.push({ k: 'rect', x, y: y + S * 0.6, w: width, h: Math.max(0.5, S * 0.06), alpha: 0.3 });
      return S * 1.2;
    }
  }
}

const MAX_CACHED = 300;
const cache = new Map<string, MdLayout>();

/** The layout of a Markdown text box (`format: 'md'`) at its width and font size. Cached. */
export function layoutMarkdown(text: string, width: number, fontSize: number): MdLayout {
  const key = `${fontSize}|${Math.round(width * 100)}|${text}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const ctx: Ctx = { ops: [] };
  const w = Math.max(1, width);
  const height = Math.max(fontSize * TEXT_LINE_HEIGHT, layBlocks(ctx, parseMarkdown(text), 0, 0, w, fontSize, 0));
  const out = { ops: ctx.ops, height };
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}
