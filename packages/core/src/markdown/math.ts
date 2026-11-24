import { HTMLHandler } from 'mathjax-full/js/handlers/html/HTMLHandler.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor, type LiteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import type { MathDocument } from 'mathjax-full/js/core/MathDocument.js';
import type { LiteElement } from 'mathjax-full/js/adaptors/lite/Element.js';
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';

/**
 * TeX maths as outlines: MathJax (TeX in, SVG out, no DOM) gives glyph paths, which are flattened here into one path in
 * a plain coordinate system, so Skia, pdf-lib and SVG all draw the same shapes without a maths font.
 */
export interface MathBox {
  /** Advance width, ascent above the baseline and descent below it, in em. */
  w: number;
  a: number;
  d: number;
  /** One SVG path (absolute M/L/H/V/C/Q/Z only), in 1/1000 em, y down, the baseline at y = 0. */
  path: string;
}

type Affine = [sx: number, sy: number, tx: number, ty: number];

/**
 * Limits on maths, so one box or comment (synced, or written by an agent) can't stall the app, PDF export or the
 * Worker: MathJax is synchronous, so the only defence is what it's given. Past a limit the TeX source is shown instead.
 */
export const MATH_LIMITS = {
  /** TeX characters in one formula. */
  texChars: 1000,
  /** Path data of one formula (~200 KB); `x+x+…` at 1000 characters makes ~500 KB. */
  pathChars: 200_000,
  /** Formulas rendered per text box or comment (`mathAllowance`). */
  perDoc: 30,
  /** TeX characters rendered per text box or comment, in total (~0.3 s of MathJax at worst, on a desktop). */
  docChars: 5000,
  /** MathJax's own limits: macro expansions per formula, and the size its input may grow to while expanding. */
  maxMacros: 500,
  maxBuffer: 4 * 1024,
} as const;

/** The AMS package's `\DeclareMathOperator` table: global in MathJax, so it is emptied after every formula. */
const AMS_DECLARED_OPS = 'ams-declare-ops';

let jax: { adaptor: LiteAdaptor; doc: MathDocument<unknown, unknown, unknown>; tex: TeX<unknown, unknown, unknown> } | null = null;
function mathJax() {
  if (jax) return jax;
  const adaptor = liteAdaptor();
  // The document comes straight from its handler, not MathJax's global handler registry (a second copy of that module,
  // as in the Workers test runtime, would leave the registry empty).
  // No `newcommand`: definitions (\def, \newcommand, \renewcommand) would outlive their formula and change every later
  // one (another user's, in the same Worker), and they're what makes TeX expand exponentially.
  const tex = new TeX({ packages: ['base', 'ams', 'noundefined', 'boldsymbol'], maxMacros: MATH_LIMITS.maxMacros, maxBuffer: MATH_LIMITS.maxBuffer });
  const doc = new HTMLHandler(adaptor).create('', { InputJax: tex, OutputJax: new SVG({ fontCache: 'none' }) });
  return (jax = { adaptor, doc, tex });
}

/** Forgets what a formula defined (`\DeclareMathOperator`, `\label`), so each formula renders the same on its own. */
function resetTex(tex: TeX<unknown, unknown, unknown>): void {
  const ops = tex.parseOptions.handlers.retrieve(AMS_DECLARED_OPS) as unknown as { map?: Map<string, unknown> } | undefined;
  ops?.map?.clear();
  tex.reset();
}

const r = (v: number) => Math.round(v * 10) / 10;

/** Applies a scale-and-translate transform to an SVG path's data, writing absolute commands. */
export function transformPath(d: string, [sx, sy, tx, ty]: Affine): string {
  const out: string[] = [];
  const re = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  // The previous curve's last control point (for S/T reflections), in source coordinates.
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  const X = (x: number) => r(x * sx + tx);
  const Y = (y: number) => r(y * sy + ty);
  for (const m of d.matchAll(re)) {
    const cmd = m[1]!;
    const nums = (m[2]!.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z' && cmd !== 'Z';
    const C = cmd.toUpperCase();
    let i = 0;
    const take = (n: number) => {
      const v = nums.slice(i, i + n);
      i += n;
      return v;
    };
    if (C === 'Z') {
      out.push('Z');
      cx = startX;
      cy = startY;
      lastC = lastQ = null;
      continue;
    }
    do {
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      if (C === 'M' || C === 'L' || C === 'T') {
        const [x, y] = take(2);
        if (y === undefined) break;
        if (C === 'T') {
          const q: [number, number] = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
          out.push(`Q${X(q[0])} ${Y(q[1])} ${X(x! + ox)} ${Y(y + oy)}`);
          lastQ = q;
        } else {
          // Further pairs after an M are lines.
          out.push(`${C === 'M' && i === 2 ? 'M' : 'L'}${X(x! + ox)} ${Y(y + oy)}`);
          lastQ = null;
        }
        cx = x! + ox;
        cy = y + oy;
        if (C === 'M' && i === 2) {
          startX = cx;
          startY = cy;
        }
        lastC = null;
      } else if (C === 'H') {
        const [x] = take(1);
        if (x === undefined) break;
        cx = x + ox;
        out.push(`L${X(cx)} ${Y(cy)}`);
        lastC = lastQ = null;
      } else if (C === 'V') {
        const [y] = take(1);
        if (y === undefined) break;
        cy = y + oy;
        out.push(`L${X(cx)} ${Y(cy)}`);
        lastC = lastQ = null;
      } else if (C === 'C' || C === 'S') {
        let x1: number, y1: number;
        if (C === 'S') {
          [x1, y1] = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
        } else {
          const v = take(2);
          if (v[1] === undefined) break;
          x1 = v[0]! + ox;
          y1 = v[1] + oy;
        }
        const [x2, y2, x, y] = take(4);
        if (y === undefined) break;
        out.push(`C${X(x1)} ${Y(y1)} ${X(x2! + ox)} ${Y(y2! + oy)} ${X(x! + ox)} ${Y(y + oy)}`);
        lastC = [x2! + ox, y2! + oy];
        lastQ = null;
        cx = x! + ox;
        cy = y + oy;
      } else if (C === 'Q') {
        const [x1, y1, x, y] = take(4);
        if (y === undefined) break;
        out.push(`Q${X(x1! + ox)} ${Y(y1! + oy)} ${X(x! + ox)} ${Y(y + oy)}`);
        lastQ = [x1! + ox, y1! + oy];
        lastC = null;
        cx = x! + ox;
        cy = y + oy;
      }
    } while (i < nums.length);
  }
  return out.join('');
}

const compose = (a: Affine, b: Affine): Affine => [a[0] * b[0], a[1] * b[1], a[0] * b[2] + a[2], a[1] * b[3] + a[3]];

/** Parses the translate/scale/matrix transforms MathJax writes; skews and rotations are not used for TeX output. */
function parseTransform(t: string | null): Affine {
  let m: Affine = [1, 1, 0, 0];
  if (!t) return m;
  for (const [, fn, args] of t.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const v = args!.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === 'translate') m = compose(m, [1, 1, v[0] ?? 0, v[1] ?? 0]);
    else if (fn === 'scale') m = compose(m, [v[0] ?? 1, v[1] ?? v[0] ?? 1, 0, 0]);
    else if (fn === 'matrix') m = compose(m, [v[0] ?? 1, v[3] ?? 1, v[4] ?? 0, v[5] ?? 0]);
  }
  return m;
}

/** Walks MathJax's SVG, collecting every path, rect and line as path data in the outer coordinate system. */
function collect(adaptor: LiteAdaptor, node: LiteElement, m: Affine, out: string[]): void {
  const kind = adaptor.kind(node);
  const attr = (k: string) => adaptor.getAttribute(node, k) as string | null;
  const num = (k: string) => Number(attr(k) ?? 0) || 0;
  let here = compose(m, parseTransform(attr('transform')));
  if (kind === 'svg') here = compose(here, [1, 1, num('x'), num('y')]);
  if (kind === 'path') {
    const d = attr('d');
    if (d) out.push(transformPath(d, here));
  } else if (kind === 'rect') {
    const [x, y, w, h] = [num('x'), num('y'), num('width'), num('height')];
    if (w > 0 && h > 0) out.push(transformPath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`, here));
  } else if (kind === 'line') {
    const [x1, y1, x2, y2] = [num('x1'), num('y1'), num('x2'), num('y2')];
    const sw = (Number(attr('stroke-width')) || 40) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [nx, ny] = [((y1 - y2) / len) * sw, ((x2 - x1) / len) * sw];
    out.push(transformPath(`M${x1 + nx} ${y1 + ny}L${x2 + nx} ${y2 + ny}L${x2 - nx} ${y2 - ny}L${x1 - nx} ${y1 - ny}Z`, here));
  }
  for (const child of adaptor.childNodes(node)) {
    if (adaptor.kind(child as LiteElement) !== '#text') collect(adaptor, child as LiteElement, here, out);
  }
}

/** Cached formulas, most recently used last, bounded by count and by the size of their paths (tests lower these). */
export const MATH_CACHE = { count: 2000, chars: 4_000_000 };
const cache = new Map<string, MathBox | null>();
let cachedChars = 0;
const sizeOf = (b: MathBox | null | undefined) => b?.path.length ?? 0;

function remember(key: string, box: MathBox | null): void {
  cache.set(key, box);
  cachedChars += sizeOf(box);
  while (cache.size > MATH_CACHE.count || cachedChars > MATH_CACHE.chars) {
    const [k, old] = cache.entries().next().value!;
    cache.delete(k);
    cachedChars -= sizeOf(old);
  }
}

/** A per-request maths budget (`withMathBudget`): TeX characters left, and a deadline where the clock moves. */
let budget: { chars: number; until: number } | null = null;
let skipped = 0;
const clock = (globalThis as { performance?: { now(): number } }).performance;
const now = () => (clock ? clock.now() : Date.now());

/**
 * Runs `fn` with at most `chars` TeX characters (and, where the clock advances during work, `ms`) of new maths: formulas
 * past it show their source. For work that renders many boxes at once, like the Worker's crops for agents. Cached
 * formulas are free. Nested budgets don't add up: the inner one applies while it runs.
 */
export function withMathBudget<T>(limit: { chars: number; ms: number }, fn: () => T): T {
  const prev = budget;
  budget = { chars: limit.chars, until: now() + limit.ms };
  try {
    return fn();
  } finally {
    budget = prev;
  }
}

/** How many formulas a budget has turned away so far (layouts that had any aren't cached). */
export const mathSkipped = (): number => skipped;

/**
 * Counts the maths of one text box or comment against `MATH_LIMITS.perDoc` and `docChars`: true while a formula may
 * still be rendered.
 */
export function mathAllowance(): (tex: string) => boolean {
  let n = 0;
  let chars = 0;
  return (tex) => {
    if (n >= MATH_LIMITS.perDoc || chars + tex.length > MATH_LIMITS.docChars) return false;
    n++;
    chars += tex.length;
    return true;
  };
}

/**
 * Lays out TeX with MathJax; null when it can't be rendered (a TeX error, or past `MATH_LIMITS` or the budget), so the
 * caller shows the source instead. `display` is display style (`$$…$$`). Cached.
 */
export function texToPath(tex: string, display: boolean): MathBox | null {
  if (tex.length > MATH_LIMITS.texChars) return null;
  const key = `${display ? 'D' : 'I'}${tex}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    // Most recently used last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (budget) {
    if (budget.chars < tex.length || now() > budget.until) {
      skipped++;
      return null;
    }
    budget.chars -= tex.length;
  }
  let box: MathBox | null = null;
  let mj: ReturnType<typeof mathJax>;
  try {
    mj = mathJax();
  } catch {
    // MathJax couldn't start here: show sources (not cached, so a later call may try again).
    return null;
  }
  try {
    const { adaptor, doc } = mj;
    const container = doc.convert(tex, { display, em: 16, ex: 8, containerWidth: 80 * 16 }) as LiteElement;
    const svg = adaptor.firstChild(container) as LiteElement;
    if (svg && adaptor.kind(svg) === 'svg' && !adaptor.outerHTML(container).includes('data-mjx-error')) {
      const [minX = 0, minY = 0, vw = 0, vh = 0] = String(adaptor.getAttribute(svg, 'viewBox') ?? '').split(/\s+/).map(Number);
      const paths: string[] = [];
      for (const child of adaptor.childNodes(svg)) collect(adaptor, child as LiteElement, [1, 1, -minX, 0], paths);
      const path = paths.join('');
      if (path.length <= MATH_LIMITS.pathChars) box = { w: vw / 1000, a: -minY / 1000, d: (vh + minY) / 1000, path };
    }
  } catch {
    box = null;
  } finally {
    resetTex(mj.tex);
  }
  remember(key, box);
  return box;
}
