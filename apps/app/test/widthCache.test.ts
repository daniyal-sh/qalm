// Markdown boxes' fallback-run widths (modules/qalm-ink/src/widthCache.ts): bounded by the text they key, not just count.
import { describe, expect, it } from 'vitest';

import { createWidthCache } from '../../../modules/qalm-ink/src/widthCache';

describe('fallback width cache', () => {
  it('measures once per key, most recently used kept', () => {
    const cache = createWidthCache({ count: 2, chars: 1000 });
    let measured = 0;
    const m = (w: number) => () => (measured++, w);
    expect(cache.get('a', m(1))).toBe(1);
    expect(cache.get('a', m(9))).toBe(1);
    cache.get('b', m(2));
    cache.get('a', m(9)); // used: kept
    cache.get('c', m(3)); // evicts b
    expect(cache.get('a', m(9))).toBe(1);
    expect(cache.get('b', m(4))).toBe(4);
    expect(measured).toBe(4);
  });

  it('a long paragraph typed a key at a time stays within the character budget', () => {
    const cache = createWidthCache({ count: 4000, chars: 100_000 });
    let text = '';
    for (let i = 0; i < 3000; i++) {
      text += 'Ж';
      cache.get(`r|16|${text}`, () => text.length * 9);
    }
    // 3000 keys of up to 3000 characters would be ~4.5 M characters.
    expect(cache.chars).toBeLessThanOrEqual(100_000);
    expect(cache.size).toBeGreaterThan(0);
    // The latest run is still cached.
    expect(cache.get(`r|16|${text}`, () => -1)).toBe(3000 * 9);
  });

  it('one key larger than the budget is still kept (the latest measure)', () => {
    const cache = createWidthCache({ count: 10, chars: 10 });
    cache.get('x'.repeat(50), () => 5);
    expect(cache.size).toBe(1);
    expect(cache.get('x'.repeat(50), () => -1)).toBe(5);
  });
});
