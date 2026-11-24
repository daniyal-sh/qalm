import { describe, expect, it } from 'vitest';

import { DEFAULT_PILL, enterFocus, isFullscreenKey, leaveFocus, parsePill, pillOrigin, pillScale, PILL_MARGIN, PILL_MIN_SCALE, snapPill } from '../src/editor/focus.logic';
import { bridgeDriver, createFullscreen, documentDriver, type FullscreenDoc } from '../src/lib/fullscreen.logic';

const key = (k: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
});

describe('fullscreen state', () => {
  it('without a driver (iPad, Android) it is the app’s own state', () => {
    const fs = createFullscreen(null);
    let calls = 0;
    fs.subscribe(() => calls++);
    expect(fs.get()).toBe(false);
    fs.toggle();
    expect(fs.get()).toBe(true);
    fs.set(true);
    expect(calls).toBe(1);
    fs.set(false);
    expect(fs.get()).toBe(false);
    expect(calls).toBe(2);
  });

  it('with a driver it follows what the OS reports, including leaving by other means', () => {
    let report: (on: boolean) => void = () => undefined;
    const asked: boolean[] = [];
    const fs = createFullscreen({ request: (on) => asked.push(on), watch: (cb) => ((report = cb), () => undefined) });
    let calls = 0;
    fs.subscribe(() => calls++);
    fs.set(true);
    expect(asked).toEqual([true]);
    expect(fs.get()).toBe(false); // not until the window says so
    report(true);
    expect(fs.get()).toBe(true);
    report(false); // Esc, the macOS green button, an OS gesture
    expect(fs.get()).toBe(false);
    expect(calls).toBe(2);
    fs.toggle();
    expect(asked).toEqual([true, true]);
  });

  it('a refused request (no user gesture) leaves the state alone', async () => {
    const fs = createFullscreen({ request: () => Promise.reject(new Error('denied')), watch: () => () => undefined });
    fs.set(true);
    await Promise.resolve();
    expect(fs.get()).toBe(false);
    const throwing = createFullscreen({ request: () => { throw new Error('no'); }, watch: () => () => undefined });
    expect(() => throwing.set(true)).not.toThrow();
  });

  it('the desktop bridge drives the window', async () => {
    let listener: ((on: boolean) => void) | null = null;
    const calls: boolean[] = [];
    const fs = createFullscreen(
      bridgeDriver({
        setFullScreen: async (on) => (calls.push(on), on),
        onFullScreenChange: (cb) => ((listener = cb), cb(false), () => undefined),
      }),
    );
    fs.toggle();
    expect(calls).toEqual([true]);
    listener!(true);
    expect(fs.get()).toBe(true);
  });

  it('the browser Fullscreen API: request, exit, and fullscreenchange (Esc)', async () => {
    const listeners = new Set<() => void>();
    const doc = {
      fullscreenEnabled: true,
      fullscreenElement: null as unknown,
      documentElement: {
        requestFullscreen: async () => {
          doc.fullscreenElement = doc.documentElement;
          listeners.forEach((f) => f());
        },
      },
      exitFullscreen: async () => {
        doc.fullscreenElement = null;
        listeners.forEach((f) => f());
      },
      addEventListener: (_t: string, f: () => void) => listeners.add(f),
      removeEventListener: (_t: string, f: () => void) => listeners.delete(f),
    } satisfies FullscreenDoc;
    const fs = createFullscreen(documentDriver(doc));
    expect(fs.get()).toBe(false);
    fs.set(true);
    await Promise.resolve();
    expect(fs.get()).toBe(true);
    // The browser leaves on Esc by itself.
    doc.fullscreenElement = null;
    listeners.forEach((f) => f());
    expect(fs.get()).toBe(false);
    expect(documentDriver({ ...doc, fullscreenEnabled: false })).toBeNull();
  });
});

describe('focus layout', () => {
  it('closes the side panels and restores them afterwards', () => {
    const { panels, saved } = enterFocus({ nav: true, comments: true });
    expect(panels).toEqual({ nav: false, comments: false });
    // A comment opened during focus is replaced by the layout from before.
    expect(leaveFocus(saved, { nav: false, comments: true })).toEqual({ nav: true, comments: true });
    expect(leaveFocus(enterFocus({ nav: false, comments: false }).saved, { nav: false, comments: true })).toEqual({ nav: false, comments: false });
    expect(leaveFocus(null, { nav: true, comments: false })).toEqual({ nav: true, comments: false });
  });

  it('keys: F11 and Ctrl+Cmd+F', () => {
    expect(isFullscreenKey(key('F11'))).toBe(true);
    expect(isFullscreenKey(key('F11', { ctrlKey: true }))).toBe(false);
    expect(isFullscreenKey(key('f', { ctrlKey: true, metaKey: true }))).toBe(true);
    expect(isFullscreenKey(key('F', { ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(true);
    expect(isFullscreenKey(key('f', { metaKey: true }))).toBe(false); // Cmd+F is find
    expect(isFullscreenKey(key('f', { ctrlKey: true }))).toBe(false);
    expect(isFullscreenKey(key('Escape'))).toBe(false);
  });
});

describe('the focus pill', () => {
  const view = { w: 1200, h: 800 };
  const pill = { w: 420, h: 52 };

  it('sits centred on its edge, inside the margins', () => {
    expect(pillOrigin(DEFAULT_PILL, view, pill)).toEqual({ left: 390, top: PILL_MARGIN });
    expect(pillOrigin({ edge: 'bottom', along: 0.5 }, view, pill)).toEqual({ left: 390, top: 800 - 52 - PILL_MARGIN });
    // Vertical on the sides.
    const side = { w: 52, h: 420 };
    expect(pillOrigin({ edge: 'left', along: 0.5 }, view, side)).toEqual({ left: PILL_MARGIN, top: 190 });
    expect(pillOrigin({ edge: 'right', along: 0 }, view, side)).toEqual({ left: 1200 - 52 - PILL_MARGIN, top: PILL_MARGIN });
    // Clamped at the ends, and clear of safe-area insets.
    expect(pillOrigin({ edge: 'top', along: 1 }, view, pill).left).toBe(1200 - 420 - PILL_MARGIN);
    expect(pillOrigin({ edge: 'top', along: 0 }, view, pill, { top: 24, left: 0, right: 0, bottom: 0 })).toEqual({ left: PILL_MARGIN, top: PILL_MARGIN + 24 });
    // Wider than the view: pinned to the start rather than off screen.
    expect(pillOrigin({ edge: 'top', along: 0.5 }, { w: 300, h: 800 }, pill).left).toBe(PILL_MARGIN);
  });

  it('snaps to the nearest edge where it was dropped', () => {
    expect(snapPill(600, 30, view)).toEqual({ edge: 'top', along: 0.5 });
    expect(snapPill(300, 780, view)).toEqual({ edge: 'bottom', along: 0.25 });
    expect(snapPill(20, 200, view)).toEqual({ edge: 'left', along: 0.25 });
    expect(snapPill(1190, 400, view)).toEqual({ edge: 'right', along: 0.5 });
    expect(snapPill(-50, 400, view).edge).toBe('left');
    expect(snapPill(-50, 400, view).along).toBe(0.5);
    expect(snapPill(5000, -10, view)).toEqual({ edge: 'right', along: 0 });
  });

  it('reads stored places defensively', () => {
    expect(parsePill({ edge: 'left', along: 0.3 })).toEqual({ edge: 'left', along: 0.3 });
    expect(parsePill({ edge: 'left', along: 7 })).toEqual({ edge: 'left', along: 1 });
    expect(parsePill({ edge: 'middle', along: 0.3 })).toEqual(DEFAULT_PILL);
    expect(parsePill({ edge: 'top', along: Number.NaN })).toEqual(DEFAULT_PILL);
    expect(parsePill(null)).toEqual(DEFAULT_PILL);
    expect(parsePill('top')).toEqual(DEFAULT_PILL);
  });
});

describe('pill on a narrow screen', () => {
  it('shrinks to fit along its edge, never below the minimum, and not at all when it fits', () => {
    const pill = { w: 440, h: 52 };
    expect(pillScale(DEFAULT_PILL, { w: 1200, h: 800 }, pill)).toBe(1);
    const s = pillScale(DEFAULT_PILL, { w: 412, h: 900 }, pill);
    expect(s).toBeCloseTo((412 - 2 * PILL_MARGIN) / 440);
    expect(pillScale(DEFAULT_PILL, { w: 300, h: 900 }, pill)).toBe(PILL_MIN_SCALE);
    // On a side edge it's the height that has to fit.
    expect(pillScale({ edge: 'left', along: 0.5 }, { w: 412, h: 900 }, { w: 52, h: 440 })).toBe(1);
  });
});
