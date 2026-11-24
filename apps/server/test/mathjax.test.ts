import { describe, expect, it } from 'vitest';
import { layoutMarkdown, texToPath } from '@qalm/core';

describe('maths in the Worker runtime', () => {
  it('MathJax renders TeX to outlines in workerd (agents’ crops draw real maths, not its source)', () => {
    const box = texToPath('\\int_0^1 x^2\\,dx', false);
    expect(box).not.toBeNull();
    expect(box!.path.length).toBeGreaterThan(100);
    expect(layoutMarkdown('$x^2$ and **b**', 300, 16).ops.some((o) => o.k === 'path')).toBe(true);
  });
});
