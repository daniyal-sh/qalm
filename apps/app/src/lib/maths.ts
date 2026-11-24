import { setMathTimeSlice } from '@qalm/core';

/**
 * New maths (MathJax) may run this long in one JS task: a page of heavy Markdown boxes, a long comment thread or an
 * export never blocks the UI for much longer (one formula is capped by `MATH_LIMITS`). The rest shows its source and
 * fills in on the next renders; PDF export waits for it (`layoutMarkdownSettled`).
 */
export const MATH_SLICE_MS = 50;

setMathTimeSlice(MATH_SLICE_MS);
