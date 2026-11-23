import { Platform } from 'react-native';

/** Whether Shift, Ctrl or Cmd is held (desktop): a tap, lasso or box then adds to the selection. */
let additive = false;
let installed = false;

export function trackModifiers(): void {
  if (installed || Platform.OS !== 'web' || typeof window === 'undefined') return;
  installed = true;
  const set = (e: KeyboardEvent | PointerEvent) => {
    additive = e.shiftKey || e.ctrlKey || e.metaKey;
  };
  window.addEventListener('keydown', set, true);
  window.addEventListener('keyup', set, true);
  window.addEventListener('pointerdown', set, true);
  window.addEventListener('blur', () => (additive = false));
}

export const isAdditive = () => additive;
