// The reviewer's scribble-out probes (re-check of PR #68): a word in a hand-drawn box, small closed letters. The rates
// they measured before the outline rules (e1e2ac8) on these same probes: 27/36, 12/24, 12/12, 12/24; with the first
// outline rules (b710096): 15/36, 0/24, 12/12, 0/24. Now at least:
import { describe, expect, it } from 'vitest';
import { erases, probes } from './scribbleProbes';

const want: Record<string, number> = { 'cos(x) in a box': 33, 'a 6.3 mm o': 23, '2o': 12, 'a 6.3 mm 8': 24 };

describe('scribbling out boxed words and small closed letters', () => {
  for (const [group, ps] of Object.entries(probes())) {
    it(`${group}: ${want[group]}/${ps.length} erased`, () => {
      const missed = ps.filter((p) => !erases(p)).map((p) => p.name);
      expect(ps.length - missed.length, missed.join('\n')).toBeGreaterThanOrEqual(want[group]!);
    });
  }
});
