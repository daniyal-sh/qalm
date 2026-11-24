import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MARK, MARK_COLORS, MARK_WEIGHTS, markWeightFor } from '../src/ui/markGeometry';

const root = join(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const brand = (): Promise<any> => import(pathToFileURL(join(root, 'assets', 'brand', 'mark.mjs')).href);

describe('the in-app mark (brand.md, "Mark")', () => {
  it('matches the brand source, assets/brand/mark.mjs', async () => {
    const m = await brand();
    expect(MARK.nib).toBe(m.NIB);
    expect(MARK.orbitFront).toBe(m.ORBIT_FRONT);
    expect(MARK.orbitBack).toBe(m.ORBIT_BACK);
    expect(MARK.planet).toEqual(m.PLANET);
    expect(MARK_COLORS).toEqual(m.COLORS);
    for (const [name, w] of Object.entries(MARK_WEIGHTS)) {
      const { viewBox, ...weights } = w;
      expect(weights).toEqual(m.WEIGHTS[name]);
      const b = m.bounds(m.WEIGHTS[name]);
      expect(viewBox).toEqual([b.x, b.y, b.w, b.h]);
    }
    for (const px of [12, 16, 17, 24, 25, 48]) expect(markWeightFor(px)).toBe(m.weightFor(px));
  });

  it('ships icons built from the graphite tile, with app.json pointing at them', () => {
    const app = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')).expo;
    expect(app.android.adaptiveIcon.backgroundColor).toBe('#1c1c1f');
    for (const p of [app.icon, app.ios.icon, app.android.adaptiveIcon.foregroundImage, app.android.adaptiveIcon.monochromeImage, app.web.favicon]) {
      expect(existsSync(join(__dirname, '..', p))).toBe(true);
    }
  });
});
