import type { InputPrefs, Palm } from '../theme/ThemeProvider';

const PALMS: readonly Palm[] = ['relaxed', 'standard', 'strict'];

/**
 * Saved input prefs over the current ones. The palm level is kept by name, so a saved "strict" stays strict when the
 * millimetres behind it change (9/7/5 → 30/20/14); anything else (a number, a typo) keeps the current level.
 */
export function loadInputPrefs(saved: Partial<InputPrefs> | undefined, cur: InputPrefs): InputPrefs {
  const next = { ...cur, ...saved };
  if (!PALMS.includes(next.palm)) next.palm = cur.palm;
  return next;
}
