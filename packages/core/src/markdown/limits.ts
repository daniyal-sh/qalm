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
  /** Path data per text box or comment, in total (~1 MB; 30 formulas at the per-formula cap would be ~6 MB). */
  docPathChars: 1_000_000,
  /** Largest width or height of one formula, in em (`\rule{1pt}{100000em}` would make a box too tall to select). */
  maxEm: 50,
  /** MathJax's own limits: macro expansions per formula, and the size its input may grow to while expanding. */
  maxMacros: 500,
  maxBuffer: 4 * 1024,
} as const;
