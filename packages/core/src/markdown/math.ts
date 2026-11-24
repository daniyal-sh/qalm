import { hasRtl } from './fonts';
import { MATH_LIMITS } from './limits';
import { parseMarkdown, type MdBlock, type MdInline } from './parse';
import type { Item } from '../types';

/**
 * TeX maths as outlines, from MathJax (`mathjax.ts`). MathJax is large and most notes have no maths, so it's loaded on
 * demand with `import()`: bundles that can split (Expo web, Electron) keep it in its own chunk, and the rest (native,
 * the Worker) only evaluate it once a note has maths. Layout stays synchronous: until MathJax has loaded, `texToPath`
 * answers `undefined` and the layout shows the raw TeX in its place; `onMathReady` tells views to lay out again.
 * Anything that must not show the placeholder (PDF export, agents' crops) awaits `loadMath` / `loadMathFor` first.
 *
 * The limits, the formula cache and the budgets live here, not in the engine, so they hold whether MathJax has loaded
 * or not: a formula past a limit shows its source without loading MathJax for it.
 */
export interface MathBox {
  /** Advance width, ascent above the baseline and descent below it, in em. */
  w: number;
  a: number;
  d: number;
  /** One SVG path (absolute M/L/H/V/C/Q/Z only), in 1/1000 em, y down, the baseline at y = 0. */
  path: string;
}

export { MATH_LIMITS } from './limits';

type Renderer = (tex: string, display: boolean) => MathBox | null;
/** A formula in parsed Markdown: inline (`$…$`) or a block (`$$…$$`). */
export type MdMath = Extract<MdInline, { t: 'math' }> | Extract<MdBlock, { t: 'math' }>;

/** Where MathJax comes from: the engine's one dynamic import. Tests swap `load` to make it fail. */
export const MATH_LOADER: { load: () => Promise<{ renderTex: Renderer }> } = { load: () => import('./mathjax') };

/** After a failed load, background requests wait this long before trying again, doubling up to the max. */
export const MATH_RETRY = { firstMs: 5000, maxMs: 60_000 };

let render: Renderer | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Failed loads in a row, and when a background request may try again (`Date.now()`). */
let failures = 0;
let retryAt = 0;
let onlineHooked = false;

/**
 * Loads MathJax (once; a failed load can be tried again). Resolves when `texToPath` can lay out TeX; rejects if the
 * load failed (offline web, or a chunk gone after a deploy). For callers that need it now (PDF export, the server):
 * it always tries. Views' background requests (`texToPath`, cached placeholder layouts) back off after a failure.
 */
export function loadMath(): Promise<void> {
  if (render) return Promise.resolve();
  loading ??= MATH_LOADER.load().then(
    (m) => {
      render = m.renderTex;
      failures = 0;
      retryAt = 0;
      for (const l of [...listeners]) l();
      // Placeholders can be filled in now: the same signal as maths a time slice deferred (`onMathDeferred`).
      notifyDeferred();
    },
    (e: unknown) => {
      loading = null;
      failures++;
      retryAt = Date.now() + Math.min(MATH_RETRY.maxMs, MATH_RETRY.firstMs * 2 ** (failures - 1));
      hookOnline();
      throw e;
    },
  );
  return loading;
}

/**
 * Starts loading MathJax in the background for a placeholder on screen, unless a load failed too recently (Expo drops
 * a failed chunk from its cache, so each try adds a failing request). Never rejects.
 */
export function requestMath(): void {
  if (render || loading || Date.now() < retryAt) return;
  loadMath().catch(() => {});
}

/** Back online (web): forget the backoff and try again at once, if a load had failed. Hooked on the first failure. */
function hookOnline(): void {
  if (onlineHooked) return;
  const w = (globalThis as { window?: { addEventListener?(type: string, cb: () => void): void } }).window;
  if (typeof w?.addEventListener !== 'function') return;
  onlineHooked = true;
  w.addEventListener('online', () => {
    if (render || !failures) return;
    failures = 0;
    retryAt = 0;
    requestMath();
  });
}

/** Whether MathJax has loaded (layouts no longer have placeholders for maths). */
export function mathReady(): boolean {
  return render !== null;
}

/** Calls `cb` once MathJax has loaded (views lay out their maths again). Returns the unsubscribe. */
export function onMathReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
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

/** How many formulas a budget, or `withoutMathPlaceholders`, has turned away so far (layouts that had any aren't cached). */
export const mathSkipped = (): number => skipped;

let noPlaceholders = 0;

/**
 * Runs `fn` with maths that MathJax isn't loaded for drawn as its TeX source (as a TeX error is), not as a placeholder,
 * and without starting a load: for output that can't be redrawn later, like a PDF export after the load failed
 * (offline web). Layouts made this way aren't cached, so the page still gets its maths once MathJax loads.
 */
export function withoutMathPlaceholders<T>(fn: () => T): T {
  noPlaceholders++;
  try {
    return fn();
  } finally {
    noPlaceholders--;
  }
}

/** False inside `withoutMathPlaceholders` (a cached layout with placeholders can't be used there). */
export const mathPlaceholdersOn = (): boolean => noPlaceholders === 0;

/** One text box's or comment's maths allowance (`mathAllowance`). */
export interface MathAllowance {
  /** Counts a formula against `MATH_LIMITS.perDoc` and `docChars`: true while one may still be rendered. */
  (tex: string): boolean;
  /** Counts a rendered formula's path against `MATH_LIMITS.docPathChars`: false (show its source) once that's spent. */
  fits(box: MathBox): boolean;
}

/** A fresh maths allowance for one text box or comment (see `MathAllowance`). */
export function mathAllowance(): MathAllowance {
  let n = 0;
  let chars = 0;
  let pathChars = 0;
  const allow = ((tex: string) => {
    if (n >= MATH_LIMITS.perDoc || chars + tex.length > MATH_LIMITS.docChars) return false;
    n++;
    chars += tex.length;
    return true;
  }) as MathAllowance;
  allow.fits = (box) => {
    if (pathChars + box.path.length > MATH_LIMITS.docPathChars) return false;
    pathChars += box.path.length;
    return true;
  };
  return allow;
}

/**
 * The app's time slice: within one JS task, new maths may run for `ms` (then formulas show their source), so a page of
 * heavy boxes, a long comment thread or an export never blocks the UI for long. When a task that ran out ends, the
 * `onMathDeferred` listeners are told, and re-render to fill the rest in, a slice at a time. A `withMathBudget` takes
 * precedence while it runs. The Worker doesn't use slices (its clock doesn't move during work): it uses budgets.
 */
let sliceMs: number | null = null;
let sliceUntil = 0;
let sliceOpen = false;
let sliceDeferred = false;
/** Formulas rendered (new) in the current task: a task that deferred maths but rendered none made no progress. */
let renderedInTask = 0;
let deferredEpoch = 0;
const deferredListeners = new Set<() => void>();
const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown };

/** Turns the time slice on (`ms`) or off (null). */
export function setMathTimeSlice(ms: number | null): void {
  sliceMs = ms;
}

/**
 * Calls `fn` when maths that couldn't be drawn can be filled in: after each task in which maths was deferred to a later
 * one, and once MathJax has loaded (its placeholders). Returns an unsubscribe.
 */
export function onMathDeferred(fn: () => void): () => void {
  deferredListeners.add(fn);
  return () => void deferredListeners.delete(fn);
}

/** Changes whenever `onMathDeferred` fires (renderers include it in what they memoise on). */
export const mathDeferredEpoch = (): number => deferredEpoch;

function notifyDeferred(): void {
  deferredEpoch++;
  for (const fn of [...deferredListeners]) fn();
}

function endSlice(): void {
  sliceOpen = false;
  const progressed = renderedInTask > 0;
  renderedInTask = 0;
  if (!sliceDeferred) return;
  sliceDeferred = false;
  // Another pass only helps if this one resolved something (renderers keep what they resolved: `MathMemo`).
  if (progressed) notifyDeferred();
}

/** True when the current task's slice is spent (and notes that maths was deferred). */
function sliceSpent(): boolean {
  if (sliceMs === null) return false;
  if (!sliceOpen) {
    // The first new formula of a task always runs (each is capped), so filling in always makes progress.
    sliceOpen = true;
    renderedInTask = 0;
    sliceUntil = now() + sliceMs;
    timers.setTimeout(endSlice, 0);
    return false;
  }
  if (now() <= sliceUntil) return false;
  sliceDeferred = true;
  return true;
}

/**
 * Lays out TeX: its outlines, or null when it can't be rendered (a TeX error, or past `MATH_LIMITS` or the budget), so
 * the caller shows the source instead. `undefined` while MathJax isn't loaded yet: this starts loading it (`requestMath`,
 * with backoff after a failure), and the caller shows a placeholder until `onMathReady`; null instead, without loading,
 * inside `withoutMathPlaceholders`. A formula over the length cap is null at once, loaded or not. `display` is display
 * style (`$$…$$`). Cached (LRU).
 */
export function texToPath(tex: string, display: boolean): MathBox | null | undefined {
  if (tex.length > MATH_LIMITS.texChars) return null;
  const key = `${display ? 'D' : 'I'}${tex}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    // Most recently used last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (!render) {
    if (noPlaceholders) {
      skipped++;
      return null;
    }
    requestMath();
    return undefined;
  }
  if (!budget && sliceSpent()) {
    skipped++;
    return null;
  }
  if (budget) {
    if (budget.chars < tex.length || now() > budget.until) {
      skipped++;
      return null;
    }
    budget.chars -= tex.length;
  }
  let box: MathBox | null;
  try {
    box = render(tex, display);
    renderedInTask++;
  } catch {
    // MathJax couldn't start here: show sources (not cached, so a later call may try again).
    return null;
  }
  remember(key, box);
  return box;
}

/**
 * The formulas of parsed Markdown in reading order: the order a box's layout meets them, so allowances counted over this
 * (the comments' `allowedMath`, `markdownNeedsMath`) match the layout's.
 */
export function mathInOrder(blocks: readonly MdBlock[]): MdMath[] {
  const out: MdMath[] = [];
  const walk = (bs: readonly MdBlock[]) => {
    for (const b of bs) {
      if (b.t === 'p' || b.t === 'h') for (const x of b.c) if (x.t === 'math') out.push(x);
      if (b.t === 'math') out.push(b);
      if (b.t === 'quote') walk(b.c);
      if (b.t === 'list') b.items.forEach(walk);
    }
  };
  walk(blocks);
  return out;
}

/**
 * Whether Markdown text has maths MathJax would render (not just a `$`, nor only formulas past the length cap or the
 * box's allowance). Renders nothing, so it never starts a load itself.
 */
export function markdownNeedsMath(text: string): boolean {
  if (!text.includes('$')) return false;
  const allow = mathAllowance();
  return mathInOrder(parseMarkdown(text)).some((x) => allow(x.tex) && x.tex.length <= MATH_LIMITS.texChars);
}

/** Loads MathJax if one of these items is a Markdown text box with maths to render; resolves at once otherwise. */
export function loadMathFor(items: Iterable<Item>): Promise<void> {
  if (render) return Promise.resolve();
  for (const it of items) if (it.type === 'text' && it.format === 'md' && !hasRtl(it.text) && markdownNeedsMath(it.text)) return loadMath();
  return Promise.resolve();
}
