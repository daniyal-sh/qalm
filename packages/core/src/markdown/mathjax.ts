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

import { MATH_LIMITS, type MathBox } from './math';

/**
 * The MathJax engine behind `math.ts` (TeX in, SVG out, no DOM): it gives glyph paths, which are flattened here into
 * one path in a plain coordinate system, so Skia, pdf-lib and SVG all draw the same shapes without a maths font.
 *
 * MathJax is most of the Markdown code's size, so only `math.ts`'s `loadMath` imports this module, with `import()`:
 * nothing else may import it, or every bundle (the app's, the Worker's) pays for maths most notes never have. The
 * limits, the caches and the budgets live in `math.ts`, so they apply before MathJax has loaded too.
 */

type Affine = [sx: number, sy: number, tx: number, ty: number];

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

/** The extent of everything a path draws (end and control points: a curve stays inside its control hull). */
export interface PathBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const emptyBounds = (): PathBounds => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

/**
 * Applies a scale-and-translate transform to an SVG path's data, writing absolute commands. `bounds`, if given, grows
 * to cover every point written.
 */
export function transformPath(d: string, [sx, sy, tx, ty]: Affine, bounds?: PathBounds): string {
  const out: string[] = [];
  const re = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  // The previous curve's last control point (for S/T reflections), in source coordinates.
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  const X = (x: number) => {
    const v = r(x * sx + tx);
    if (bounds) {
      if (v < bounds.x0) bounds.x0 = v;
      if (v > bounds.x1) bounds.x1 = v;
    }
    return v;
  };
  const Y = (y: number) => {
    const v = r(y * sy + ty);
    if (bounds) {
      if (v < bounds.y0) bounds.y0 = v;
      if (v > bounds.y1) bounds.y1 = v;
    }
    return v;
  };
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
function collect(adaptor: LiteAdaptor, node: LiteElement, m: Affine, out: string[], bounds: PathBounds): void {
  const kind = adaptor.kind(node);
  const attr = (k: string) => adaptor.getAttribute(node, k) as string | null;
  const num = (k: string) => Number(attr(k) ?? 0) || 0;
  let here = compose(m, parseTransform(attr('transform')));
  if (kind === 'svg') here = compose(here, [1, 1, num('x'), num('y')]);
  if (kind === 'path') {
    const d = attr('d');
    if (d) out.push(transformPath(d, here, bounds));
  } else if (kind === 'rect') {
    const [x, y, w, h] = [num('x'), num('y'), num('width'), num('height')];
    if (w > 0 && h > 0) out.push(transformPath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`, here, bounds));
  } else if (kind === 'line') {
    const [x1, y1, x2, y2] = [num('x1'), num('y1'), num('x2'), num('y2')];
    const sw = (Number(attr('stroke-width')) || 40) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [nx, ny] = [((y1 - y2) / len) * sw, ((x2 - x1) / len) * sw];
    out.push(transformPath(`M${x1 + nx} ${y1 + ny}L${x2 + nx} ${y2 + ny}L${x2 - nx} ${y2 - ny}L${x1 - nx} ${y1 - ny}Z`, here, bounds));
  }
  for (const child of adaptor.childNodes(node)) {
    if (adaptor.kind(child as LiteElement) !== '#text') collect(adaptor, child as LiteElement, here, out, bounds);
  }
}

/**
 * Lays out TeX with MathJax: null when it can't be rendered (a TeX error, or outlines past `MATH_LIMITS.pathChars`, or
 * a box or painted extent past `maxEm`).
 * `display` is display style (`$$…$$`). Throws if MathJax can't start here (the caller shows the source, uncached).
 * Every formula starts from a clean state: what one defines (`\DeclareMathOperator`, `\label`) is forgotten after it.
 */
export function renderTex(tex: string, display: boolean): MathBox | null {
  const mj = mathJax();
  try {
    const { adaptor, doc } = mj;
    const container = doc.convert(tex, { display, em: 16, ex: 8, containerWidth: 80 * 16 }) as LiteElement;
    const svg = adaptor.firstChild(container) as LiteElement;
    const html = adaptor.outerHTML(container);
    if (!svg || adaptor.kind(svg) !== 'svg' || html.includes('data-mjx-error')) return null;
    // Characters MathJax's fonts lack (`\text{café}`, `\text{日本}`) come out as <text> for a browser to draw: as paths
    // they'd vanish, leaving a gap, so the formula shows its source.
    if (/<text[\s>]/.test(html)) return null;
    const [minX = 0, minY = 0, vw = 0, vh = 0] = String(adaptor.getAttribute(svg, 'viewBox') ?? '').split(/\s+/).map(Number);
    const paths: string[] = [];
    const bounds = emptyBounds();
    for (const child of adaptor.childNodes(svg)) collect(adaptor, child as LiteElement, [1, 1, -minX, 0], paths, bounds);
    const path = paths.join('');
    const size = { w: vw / 1000, a: -minY / 1000, d: (vh + minY) / 1000 };
    // What it paints, not just its box: \smash, \rlap and negative space give a tiny box a path reaching 1000 em away.
    const reach = (lo: number, hi: number, b0: number, b1: number) => (Math.max(hi, b1) - Math.min(lo, b0)) / 1000;
    const painted = bounds.x0 > bounds.x1 ? { w: size.w, h: size.a + size.d } : { w: reach(0, vw, bounds.x0, bounds.x1), h: reach(minY, vh + minY, bounds.y0, bounds.y1) };
    const fits = size.w <= MATH_LIMITS.maxEm && size.a + size.d <= MATH_LIMITS.maxEm && painted.w <= MATH_LIMITS.maxEm && painted.h <= MATH_LIMITS.maxEm;
    return path.length <= MATH_LIMITS.pathChars && fits ? { ...size, path } : null;
  } catch {
    return null;
  } finally {
    resetTex(mj.tex);
  }
}
