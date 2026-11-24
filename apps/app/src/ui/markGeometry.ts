// The qalm mark's geometry, copied from assets/brand/mark.mjs (test/brand.test.ts keeps the two in step).
// Mark A, "nib in orbit": a nib outline with a slit and a breather hole; the orbit passes behind the nib at the top and
// in front of it at the bottom; the planet rides the front of the ring. Masks (not an occluder fill) cut the back arc
// inside the nib and both arcs around the planet, so the mark draws on any surface.

export const MARK = {
  nib: 'M50 90 C44 76 33 65 33 51 C33 39 40 28 50 14 C60 28 67 39 67 51 C67 65 56 76 50 90Z',
  orbitFront: 'M7.71 67.39A45 15 -20 0 0 92.29 36.61',
  orbitBack: 'M92.29 36.61A45 15 -20 0 0 7.71 67.39',
  slit: 'M50 82V58',
  hole: { cx: 50, cy: 51 },
  planet: { cx: 87.61, cy: 47.45 },
} as const;

export type MarkWeight = 'regular' | 'small' | 'tiny';

/** Stroke weights and the viewBox (x, y, width, height) tight to the ink at each weight (heavier below 24 px; see docs/brand.md). */
export const MARK_WEIGHTS: Record<MarkWeight, { nib: number; orbit: number; slit: number; hole: number; planet: number; halo: number; viewBox: readonly [number, number, number, number] }> = {
  regular: { nib: 6, orbit: 5, slit: 4.5, hole: 4.2, planet: 6.2, halo: 1.6, viewBox: [4.4, 10.5, 91.19, 83] },
  small: { nib: 8, orbit: 7, slit: 5.5, hole: 5.2, planet: 8.4, halo: 1.8, viewBox: [3.4, 9.5, 93.19, 85] },
  tiny: { nib: 9, orbit: 7.5, slit: 6, hole: 0, planet: 10, halo: 2, viewBox: [3.15, 9, 94.96, 86] },
};

/** Light-surface and dark-surface colours (assets/brand/qalm-mark.svg and qalm-mark-dark.svg). */
export const MARK_COLORS = {
  light: { ink: '#27272a', orbit: '#4338ca', planet: '#1d4ed8' },
  dark: { ink: '#f4f4f5', orbit: '#7b72ff', planet: '#60a5fa' },
} as const;

export const markWeightFor = (px: number): MarkWeight => (px <= 16 ? 'tiny' : px <= 24 ? 'small' : 'regular');
