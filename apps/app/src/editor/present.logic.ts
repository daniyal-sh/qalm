// Presentation view's keys (pure): which page a key goes to, what stops it, and keeping the page index valid.

/** What a key does while presenting: go to a page, switch the laser's mode, stop, or nothing (let it through). */
export type PresentAction = { page: number } | 'laser' | 'stop' | null;

/**
 * The action for `key` (KeyboardEvent.key, any case) on page `at` of `count`. `onButton`: the key went to a focused
 * button, where Space and Enter press that button (turning the page again would skip one).
 */
export function presentKey(key: string, at: number, count: number, onButton = false): PresentAction {
  const k = key.toLowerCase();
  if ((k === ' ' || k === 'enter') && onButton) return null;
  const last = Math.max(0, count - 1);
  const go = (i: number) => ({ page: Math.max(0, Math.min(last, i)) });
  if (k === 'arrowright' || k === 'arrowdown' || k === 'pagedown' || k === ' ' || k === 'enter') return go(at + 1);
  if (k === 'arrowleft' || k === 'arrowup' || k === 'pageup' || k === 'backspace') return go(at - 1);
  if (k === 'home') return go(0);
  if (k === 'end') return go(last);
  if (k === 'k') return 'laser';
  if (k === 'escape' || k === 'f5') return 'stop';
  return null;
}

/** The page to show when the notebook now has `count` pages (some deleted elsewhere), or null: none left, stop. */
export function clampPresent(at: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.min(Math.max(0, at), count - 1);
}

/** F5: never the browser's reload (it would lose what's being typed); outside a text field it presents or stops. */
export function f5Action(typing: boolean, presenting: boolean): 'start' | 'stop' | 'none' {
  if (typing) return 'none';
  return presenting ? 'stop' : 'start';
}
