import { describe, expect, it } from 'vitest';

import { dark, light, motion, radius, shadow1, shadow2, space, typeRamp } from '../src/theme/tokens';
import { globalCss } from '../src/theme/webCss';

describe('design tokens (brand.md)', () => {
  it('keeps the brand radii and the 120–200 ms motion range', () => {
    expect(radius.control).toBe(8);
    expect(radius.panel).toBe(12);
    expect(motion.fast).toBeGreaterThanOrEqual(120);
    expect(motion.slow).toBeLessThanOrEqual(200);
  });

  it('uses the exact brand shadows, with no blur filters', () => {
    expect(shadow1.boxShadow).toBe('0 1px 2px rgba(0,0,0,0.04)');
    expect(shadow2.boxShadow).toBe('0 18px 40px -16px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.04)');
  });

  it('sizes type by the brand ramp: titles 24–30, sections 16–20, body 14–16, metadata 12', () => {
    expect(typeRamp.title.fontSize).toBeGreaterThanOrEqual(24);
    expect(typeRamp.display.fontSize).toBeLessThanOrEqual(30);
    expect(typeRamp.section.fontSize).toBeGreaterThanOrEqual(16);
    expect(typeRamp.section.fontSize).toBeLessThanOrEqual(20);
    expect(typeRamp.body.fontSize).toBeGreaterThanOrEqual(14);
    expect(typeRamp.meta.fontSize).toBe(12);
    for (const t of Object.values(typeRamp)) expect(t.lineHeight % 2).toBe(0);
  });

  it('spaces on a 2 px grid and gives each theme a solid scrim', () => {
    for (const v of Object.values(space)) expect(v % 2).toBe(0);
    expect(light.scrim).toMatch(/^rgba\(/);
    expect(dark.scrim).toMatch(/^rgba\(/);
  });
});

describe('global web CSS', () => {
  const css = globalCss(light);
  it('draws focus rings for keyboard focus only', () => {
    expect(css).toContain(':focus-visible');
    expect(css).toContain(`outline: 2px solid ${light.accentLine}`);
    expect(css).toContain(':focus:not(:focus-visible) { outline: none; }');
  });
  it('turns transitions and animations off under reduced motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('transition-duration: 0ms !important');
  });
  it('never uses gradients or blur', () => {
    expect(css).not.toMatch(/gradient|blur\(/);
  });
});
