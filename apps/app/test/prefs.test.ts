import { describe, expect, it } from 'vitest';

import { autoDrawWith, loadInputPrefs, withPenSeen } from '../src/lib/inputPrefs';
import type { InputPrefs } from '../src/theme/ThemeProvider';

const DEFAULTS: InputPrefs = { drawWith: 'any', drawWithAuto: true, penSeen: false, hand: 'right', palm: 'standard', penGesture: 'eraser', smoothing: 'medium', scribbleErase: true };

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

describe('"draw with" auto-pick', () => {
  it('is pen and finger without a pen, pen only with one', () => {
    expect([autoDrawWith(false), autoDrawWith(true)]).toEqual(['any', 'pen']);
  });

  it('is pen only once a pen was seen, unless the user chose', () => {
    expect(loadInputPrefs({ penSeen: true, drawWithAuto: true, drawWith: 'any' }, DEFAULTS).drawWith).toBe('pen');
    expect(loadInputPrefs({ penSeen: true, drawWithAuto: false, drawWith: 'any' }, DEFAULTS).drawWith).toBe('any');
    expect(loadInputPrefs({ penSeen: false, drawWithAuto: false, drawWith: 'pen' }, DEFAULTS).drawWith).toBe('pen');
  });

  it('reads prefs saved before auto-pick: a saved "pen" was a choice, a saved "any" may be the default', () => {
    expect(loadInputPrefs({ drawWith: 'pen' }, DEFAULTS)).toMatchObject({ drawWith: 'pen', drawWithAuto: false });
    expect(loadInputPrefs({ drawWith: 'any' }, DEFAULTS)).toMatchObject({ drawWith: 'any', drawWithAuto: true });
  });

  it('never forgets a pen it has seen', () => {
    expect(loadInputPrefs({ penSeen: false }, { ...DEFAULTS, penSeen: true }).penSeen).toBe(true);
  });

  it('switches to pen only on the first pen, once, and never over a choice', () => {
    const first = withPenSeen(DEFAULTS);
    expect(first).toEqual({ next: { ...DEFAULTS, penSeen: true, drawWith: 'pen' }, switched: true });
    expect(withPenSeen(first!.next)).toBeNull();
    expect(withPenSeen({ ...DEFAULTS, drawWithAuto: false })).toEqual({ next: { ...DEFAULTS, drawWithAuto: false, penSeen: true }, switched: false });
  });
});
