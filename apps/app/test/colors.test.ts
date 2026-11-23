import { describe, expect, it } from 'vitest';

import { dropIndex, hexToHsl, hslToHex, sameColor, swatchLabel, swatchToolFor, toneGrid } from '../src/editor/colors.logic';

describe('colour picker logic', () => {
  it('maps tools to swatch lists', () => {
    expect(swatchToolFor('pen')).toBe('pen');
    expect(swatchToolFor('text')).toBe('pen');
    expect(swatchToolFor('highlighter')).toBe('highlighter');
  });

  it('labels brand colours by name and others by hex', () => {
    expect(swatchLabel('pen', '#27272a')).toBe('Graphite');
    expect(swatchLabel('pen', '#ff8800')).toBe('#ff8800');
    expect(swatchLabel('highlighter', '#fde68a')).toBe('Yellow');
    expect(swatchLabel('highlighter', '#fde68a80')).toBe('#fde68a, 50%');
  });

  it('round-trips HSL', () => {
    for (const hex of ['#4338ca', '#0f766e', '#b45309', '#808080', '#ffffff', '#000000']) {
      expect(hslToHex(hexToHsl(hex))).toBe(hex);
    }
    expect(hslToHex({ h: 0, s: 1, l: 0.5 })).toBe('#ff0000');
    expect(hslToHex({ h: 120, s: 1, l: 0.5 })).toBe('#00ff00');
  });

  it('builds a 5×7 tone grid of distinct colours', () => {
    const g = toneGrid(220);
    expect(g).toHaveLength(5);
    expect(g.every((r) => r.length === 7)).toBe(true);
    expect(new Set(g.flat()).size).toBe(35);
    expect(g[4]![0]).toBe('#1f1f1f');
  });

  it('compares colours loosely and computes drop slots', () => {
    expect(sameColor('#ABC', '#aabbcc')).toBe(true);
    expect(dropIndex(2, 85, 42, 6)).toBe(4);
    expect(dropIndex(2, -500, 42, 6)).toBe(0);
    expect(dropIndex(2, 500, 42, 6)).toBe(5);
  });
});

describe('swatch contrast', () => {
  it('flags swatches that vanish against the toolbar', async () => {
    const { contrastRatio } = await import('../src/editor/colors.logic');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#27272a', '#1c1c1f')).toBeLessThan(1.6); // graphite on the dark toolbar
    expect(contrastRatio('#4338ca', '#1c1c1f')).toBeGreaterThan(1.6);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });
});
