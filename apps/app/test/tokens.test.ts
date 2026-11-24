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

function lum(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('text on solid fills', () => {
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    it(`is readable (≥ 4.5:1) in ${name} mode`, () => {
      expect(contrast(t.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.onAssistant, t.assistant)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.onBad, t.bad)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('right-click on web', () => {
  it('stops non-primary mouseups before the responder sees them, and lets the primary one through', async () => {
    const { quietNonPrimaryMouseUp } = await import('../src/lib/webMouse');
    let handler: ((e: Event) => void) | null = null;
    quietNonPrimaryMouseUp({ addEventListener: (_t: string, h: never) => (handler = h) } as never);
    let stopped = 0;
    const ev = (button: number) => ({ button, stopImmediatePropagation: () => stopped++ }) as unknown as Event;
    handler!(ev(2));
    handler!(ev(1));
    handler!(ev(0));
    expect(stopped).toBe(2);
  });
  it('keeps no focus ring on a control that turned disabled', () => {
    expect(globalCss(light)).toContain('[aria-disabled="true"]:focus');
  });
});
