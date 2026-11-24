import * as React from 'react';
import { useColorScheme } from 'react-native';

import { autoDrawWith, loadInputPrefs, withPenSeen } from '../lib/inputPrefs';
import { kvGet, kvSet } from '../lib/kv';
import { applyWebScrollbars } from './scrollbars';
import { applyWebGlobals } from './webCss';
import { dark, light, type Colors } from './tokens';

export type Appearance = 'system' | 'light' | 'dark';

export type DrawWith = 'pen' | 'any';
export type Hand = 'left' | 'right';
export type Palm = 'relaxed' | 'standard' | 'strict';
export type PenGesture = 'eraser' | 'last' | 'none';

export interface InputPrefs {
  /** What draws now: auto-picked (see `drawWithAuto`) or the user's choice in Settings. */
  drawWith: DrawWith;
  /** `drawWith` was picked automatically: "pen and finger" until a real pen is seen, then "pen only". */
  drawWithAuto: boolean;
  /** This device has reported a real pen (web pointerType 'pen', Android stylus, Apple Pencil). */
  penSeen: boolean;
  hand: Hand;
  palm: Palm;
  penGesture: PenGesture;
  /** Pen stroke smoothing (tech-spec §2). Stored on each new stroke as a level, see `smoothingLevel`. */
  smoothing: SmoothingPref;
}

export type SmoothingPref = 'low' | 'medium' | 'high';
/** The `Smoothing` level (@qalm/core) stored on new pen strokes. */
export const smoothingLevel = (s: SmoothingPref): 1 | 2 | 3 => (s === 'low' ? 1 : s === 'high' ? 3 : 2);

export const DEFAULT_INPUT: InputPrefs = {
  drawWith: autoDrawWith(false),
  drawWithAuto: true,
  penSeen: false,
  hand: 'right',
  palm: 'standard',
  penGesture: 'eraser',
  smoothing: 'medium',
};

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
  /** An ink overlay saw a real pen (its `onPenSeen`). The first time, it may switch "draw with" to pen only. */
  notePenSeen(): void;
  /** Counts the times the first pen switched "draw with" to pen only (once per device): the toast's trigger. */
  penSwitched: number;
}

const ThemeContext = React.createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [prefs, setPrefs] = React.useState<Prefs>({ appearance: 'system', input: DEFAULT_INPUT });

  React.useEffect(() => {
    void kvGet<Partial<Prefs>>('prefs').then((p) => {
      if (p) setPrefs((cur) => ({ appearance: p.appearance ?? cur.appearance, input: loadInputPrefs(p.input, cur.input) }));
    });
  }, []);

  const update = React.useCallback((fn: (p: Prefs) => Prefs) => {
    setPrefs((cur) => {
      const next = fn(cur);
      void kvSet('prefs', next);
      return next;
    });
  }, []);

  const [penSwitched, setPenSwitched] = React.useState(0);
  const prefsRef = React.useRef(prefs);
  prefsRef.current = prefs;
  const penNoted = React.useRef(false); // several overlays (pages) report their first pen at once
  const notePenSeen = React.useCallback(() => {
    if (penNoted.current) return;
    const r = withPenSeen(prefsRef.current.input);
    if (!r) return;
    penNoted.current = true;
    update((p) => ({ ...p, input: withPenSeen(p.input)?.next ?? p.input }));
    if (r.switched) setPenSwitched((n) => n + 1);
  }, [update]);

  const scheme = prefs.appearance === 'system' ? (system === 'dark' ? 'dark' : 'light') : prefs.appearance;
  // Web / Electron: slim, theme-aware scrollbars (see scrollbars.ts).
  React.useEffect(() => {
    const colors = scheme === 'dark' ? dark : light;
    applyWebScrollbars(scheme, colors);
    applyWebGlobals(colors);
  }, [scheme]);
  const value = React.useMemo<ThemeValue>(
    () => ({
      c: scheme === 'dark' ? dark : light,
      scheme,
      appearance: prefs.appearance,
      setAppearance: (appearance) => update((p) => ({ ...p, appearance })),
      input: prefs.input,
      setInput: (patch) => update((p) => ({ ...p, input: { ...p.input, ...patch } })),
      notePenSeen,
      penSwitched,
    }),
    [scheme, prefs, update, notePenSeen, penSwitched],
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
