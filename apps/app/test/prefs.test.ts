import { describe, expect, it } from 'vitest';

import { loadInputPrefs } from '../src/lib/inputPrefs';
import type { InputPrefs } from '../src/theme/ThemeProvider';

const DEFAULTS: InputPrefs = { drawWith: 'any', hand: 'right', palm: 'standard', penGesture: 'eraser', smoothing: 'medium' };

describe('saved input prefs', () => {
  it('keeps the palm level by name when its millimetres change', () => {
    for (const palm of ['relaxed', 'standard', 'strict'] as const) expect(loadInputPrefs({ palm }, DEFAULTS).palm).toBe(palm);
    expect(loadInputPrefs({ palm: 'strict', hand: 'left' }, DEFAULTS)).toEqual({ ...DEFAULTS, palm: 'strict', hand: 'left' });
  });

  it('falls back to the current level for a number or an unknown name', () => {
    expect(loadInputPrefs({ palm: 7 as never }, DEFAULTS).palm).toBe('standard');
    expect(loadInputPrefs({ palm: 'bogus' as never }, DEFAULTS).palm).toBe('standard');
    expect(loadInputPrefs(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });
});
