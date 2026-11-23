import * as React from 'react';
import { useColorScheme } from 'react-native';

import { kvGet, kvSet } from '../lib/kv';
import { dark, light, type Colors } from './tokens';

export type Appearance = 'system' | 'light' | 'dark';

export type DrawWith = 'pen' | 'any';
export type Hand = 'left' | 'right';
export type Palm = 'relaxed' | 'standard' | 'strict';
export type PenGesture = 'eraser' | 'last' | 'none';

export interface InputPrefs {
  drawWith: DrawWith;
  hand: Hand;
  palm: Palm;
  penGesture: PenGesture;
}

export const DEFAULT_INPUT: InputPrefs = { drawWith: 'any', hand: 'right', palm: 'standard', penGesture: 'eraser' };

interface Prefs {
  appearance: Appearance;
  input: InputPrefs;
}

interface ThemeValue {
  c: Colors;
  scheme: 'light' | 'dark';
  appearance: Appearance;
  setAppearance(a: Appearance): void;
  input: InputPrefs;
  setInput(patch: Partial<InputPrefs>): void;
}

const ThemeContext = React.createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [prefs, setPrefs] = React.useState<Prefs>({ appearance: 'system', input: DEFAULT_INPUT });

  React.useEffect(() => {
    void kvGet<Partial<Prefs>>('prefs').then((p) => {
      if (p) setPrefs((cur) => ({ appearance: p.appearance ?? cur.appearance, input: { ...cur.input, ...p.input } }));
    });
  }, []);

  const update = React.useCallback((fn: (p: Prefs) => Prefs) => {
    setPrefs((cur) => {
      const next = fn(cur);
      void kvSet('prefs', next);
      return next;
    });
  }, []);

  const scheme = prefs.appearance === 'system' ? (system === 'dark' ? 'dark' : 'light') : prefs.appearance;
  const value = React.useMemo<ThemeValue>(
    () => ({
      c: scheme === 'dark' ? dark : light,
      scheme,
      appearance: prefs.appearance,
      setAppearance: (appearance) => update((p) => ({ ...p, appearance })),
      input: prefs.input,
      setInput: (patch) => update((p) => ({ ...p, input: { ...p.input, ...patch } })),
    }),
    [scheme, prefs, update],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = React.useContext(ThemeContext);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}

/** StyleSheet factory memoized on the theme colours. */
export function useStyles<T>(make: (c: Colors) => T): T {
  const { c } = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => make(c), [c]);
}
