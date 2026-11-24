// Fullscreen for the editor's focus layout (state in fullscreen.logic.ts):
// - desktop: the window (BrowserWindow.setFullScreen through the preload bridge; F11 / Ctrl+Cmd+F handled in main);
// - browsers: the Fullscreen API on the document element (F11 / Ctrl+Cmd+F here, Esc as browsers do);
// - iPad and Android: the app's own state; the editor hides the status bar (and on Android the navigation bar).
import * as React from 'react';
import { Platform } from 'react-native';

import { isFullscreenKey } from '../editor/focus.logic';
import { desktop } from './desktop';
import { bridgeDriver, createFullscreen, documentDriver, type FullscreenDoc, type FullscreenDriver } from './fullscreen.logic';

function pickDriver(): FullscreenDriver | null {
  if (Platform.OS !== 'web') return null;
  const d = desktop();
  if (d?.setFullScreen && d.onFullScreenChange) return bridgeDriver({ setFullScreen: d.setFullScreen, onFullScreenChange: d.onFullScreenChange });
  return typeof document !== 'undefined' ? documentDriver(document as unknown as FullscreenDoc) : null;
}

const store = createFullscreen(pickDriver());

export const setFullscreen = (on: boolean) => store.set(on);
export const toggleFullscreen = () => store.toggle();

/** Whether the app is fullscreen (and the editor shows its focus layout). */
export function useFullscreen(): boolean {
  return React.useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Browsers: F11 and Ctrl+Cmd+F toggle fullscreen. (The desktop app handles them in its main process.) */
export function useFullscreenShortcut() {
  React.useEffect(() => {
    if (Platform.OS !== 'web' || desktop()) return;
    const onKey = (ev: KeyboardEvent) => {
      if (!isFullscreenKey(ev)) return;
      ev.preventDefault();
      store.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
