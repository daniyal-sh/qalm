/**
 * Web: react-native-web's responder ignores a right- or middle-button `mousedown` (it isn't a touch start) but still
 * records the matching `mouseup` as a touch end, which logs "Cannot record touch end without a touch start" on every
 * right-click (the page's right-button eraser, the swatch menu). Nothing in qalm listens for a non-primary `mouseup`:
 * the ink overlay uses pointer events and menus use `contextmenu`, so those `mouseup`s stop at the window.
 */
export function quietNonPrimaryMouseUp(target: Pick<Window, 'addEventListener'> | undefined = typeof window !== 'undefined' ? window : undefined): void {
  if (!target?.addEventListener) return;
  target.addEventListener(
    'mouseup',
    (e: Event) => {
      if ((e as MouseEvent).button !== 0) e.stopImmediatePropagation();
    },
    true,
  );
}
