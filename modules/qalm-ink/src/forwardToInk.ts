// Web / Electron only: the ruler (in the app) hands a pen that lands on it to the ink overlay underneath.

/**
 * The ruler sits over the pages and moves with fingers and the mouse, but a pen landing on it writes: the ruler hands
 * the pen's pointerdown to the ink overlay under it (which then captures the pointer), so a stroke can start over the
 * ruler's half next to an edge and follow that edge. Returns whether an overlay took it.
 */
export function forwardToInk(ev: PointerEvent): boolean {
  if (typeof document === 'undefined') return false;
  const target = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el instanceof HTMLCanvasElement && el.dataset.qalmInk === '1');
  if (!target) return false;
  target.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerId: ev.pointerId,
      pointerType: ev.pointerType,
      isPrimary: ev.isPrimary,
      clientX: ev.clientX,
      clientY: ev.clientY,
      screenX: ev.screenX,
      screenY: ev.screenY,
      button: ev.button,
      buttons: ev.buttons,
      pressure: ev.pressure,
      tiltX: ev.tiltX,
      tiltY: ev.tiltY,
      twist: ev.twist,
      width: ev.width,
      height: ev.height,
      altitudeAngle: (ev as PointerEvent & { altitudeAngle?: number }).altitudeAngle,
      azimuthAngle: (ev as PointerEvent & { azimuthAngle?: number }).azimuthAngle,
      bubbles: true,
      cancelable: true,
    } as PointerEventInit),
  );
  return true;
}
