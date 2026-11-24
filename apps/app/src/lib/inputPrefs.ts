import type { InputPrefs, Palm } from '../theme/ThemeProvider';

const PALMS: readonly Palm[] = ['relaxed', 'standard', 'strict'];

/** "Draw with" when nobody chose: pen only once this device has shown a real pen, else pen and finger. */
export const autoDrawWith = (penSeen: boolean): InputPrefs['drawWith'] => (penSeen ? 'pen' : 'any');

/**
 * Saved input prefs over the current ones. The palm level is kept by name, so a saved "strict" stays strict when the
 * millimetres behind it change (9/7/5 → 30/20/14); anything else (a number, a typo) keeps the current level.
 *
 * "Draw with" is auto-picked (`drawWithAuto`) until the user chooses in Settings. Prefs saved before auto-pick have no
 * `drawWithAuto`: a saved "pen" was a choice (the default was "pen and finger"), a saved "any" may just be the default.
 */
export function loadInputPrefs(saved: Partial<InputPrefs> | undefined, cur: InputPrefs): InputPrefs {
  const next = { ...cur, ...saved };
  if (!PALMS.includes(next.palm)) next.palm = cur.palm;
  next.penSeen = !!(saved?.penSeen || cur.penSeen);
  if (typeof saved?.drawWithAuto !== 'boolean') next.drawWithAuto = saved?.drawWith === 'pen' ? false : cur.drawWithAuto;
  if (next.drawWith !== 'pen' && next.drawWith !== 'any') next.drawWith = cur.drawWith;
  if (typeof next.scribbleErase !== 'boolean') next.scribbleErase = cur.scribbleErase;
  if (next.drawWithAuto) next.drawWith = autoDrawWith(next.penSeen);
  return next;
}

/**
 * A real pen was seen. Returns the prefs to save (null if nothing changes) and whether "draw with" switched to pen
 * only (the one-time toast): only on the first pen, and never over the user's own choice.
 */
export function withPenSeen(cur: InputPrefs): { next: InputPrefs; switched: boolean } | null {
  if (cur.penSeen) return null;
  const drawWith = cur.drawWithAuto ? autoDrawWith(true) : cur.drawWith;
  return { next: { ...cur, penSeen: true, drawWith }, switched: drawWith !== cur.drawWith };
}

/** The one-time toast when the first pen switches "draw with" to pen only. */
export const PEN_DETECTED_TOAST = 'Pen detected: fingers now scroll. Change in Settings.';
