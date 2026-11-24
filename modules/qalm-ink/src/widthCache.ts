/**
 * Measured widths by key, most recently used last, bounded by count and by the total length of the keys: a key holds a
 * whole fallback run (a long Cyrillic paragraph is one run, and adds a new key with every keystroke), so a count alone
 * could keep megabytes of text alive. Pure (no Skia), so it can be tested on its own.
 */
export interface WidthCache {
  /** The width for `key`, measured with `measure` on a miss. */
  get(key: string, measure: () => number): number;
  readonly size: number;
  /** Total length of the cached keys. */
  readonly chars: number;
}

export function createWidthCache(limit: { count: number; chars: number }): WidthCache {
  const widths = new Map<string, number>();
  let chars = 0;
  return {
    get(key, measure) {
      const hit = widths.get(key);
      if (hit !== undefined) {
        widths.delete(key);
        widths.set(key, hit);
        return hit;
      }
      const w = measure();
      widths.set(key, w);
      chars += key.length;
      while (widths.size > limit.count || (chars > limit.chars && widths.size > 1)) {
        const k = widths.keys().next().value!;
        widths.delete(k);
        chars -= k.length;
      }
      return w;
    },
    get size() {
      return widths.size;
    },
    get chars() {
      return chars;
    },
  };
}
