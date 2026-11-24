// Fullscreen state (pure, no React Native imports so it runs in unit tests). A driver does the platform's real
// fullscreen and reports when it changes by other means (Esc, the macOS green button, OS gestures); without one
// (iPad, Android, browsers with no Fullscreen API) the state is the app's own and the editor hides the system bars.

export interface FullscreenDriver {
  request(on: boolean): unknown;
  /** Calls `cb` with the current state now (or soon) and on every change. Returns an unsubscribe. */
  watch(cb: (on: boolean) => void): () => void;
}

export interface FullscreenStore {
  get(): boolean;
  set(on: boolean): void;
  toggle(): void;
  subscribe(cb: () => void): () => void;
}

export function createFullscreen(driver: FullscreenDriver | null): FullscreenStore {
  let on = false;
  const subs = new Set<() => void>();
  const update = (v: boolean) => {
    if (v === on) return;
    on = v;
    subs.forEach((f) => f());
  };
  let watching = false;
  const ensureWatching = () => {
    if (watching || !driver) return;
    watching = true;
    driver.watch(update);
  };
  const store: FullscreenStore = {
    get: () => {
      ensureWatching();
      return on;
    },
    set: (v) => {
      ensureWatching();
      // With a driver the OS has the last word: the state changes when it reports back.
      if (!driver) return update(v);
      try {
        const r = driver.request(v);
        if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined);
      } catch {
        /* refused (no user gesture, or not allowed): the state stays as it is */
      }
    },
    toggle: () => store.set(!store.get()),
    subscribe: (cb) => {
      ensureWatching();
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
  return store;
}

/** The desktop bridge's window fullscreen (BrowserWindow.setFullScreen). */
export interface FullscreenBridge {
  setFullScreen(on: boolean): Promise<boolean>;
  onFullScreenChange(cb: (on: boolean) => void): () => void;
}

export function bridgeDriver(b: FullscreenBridge): FullscreenDriver {
  return { request: (on) => b.setFullScreen(on), watch: (cb) => b.onFullScreenChange(cb) };
}

/** The part of `document` the Fullscreen API needs. */
export interface FullscreenDoc {
  fullscreenEnabled?: boolean;
  fullscreenElement: unknown;
  documentElement: { requestFullscreen?: () => Promise<void> };
  exitFullscreen?: () => Promise<void>;
  addEventListener(type: 'fullscreenchange', cb: () => void): void;
  removeEventListener(type: 'fullscreenchange', cb: () => void): void;
}

/** A browser's Fullscreen API, or null where there is none (iPhone Safari). */
export function documentDriver(doc: FullscreenDoc): FullscreenDriver | null {
  if (!doc.fullscreenEnabled || typeof doc.documentElement.requestFullscreen !== 'function') return null;
  return {
    request: (on) => {
      if (on === !!doc.fullscreenElement) return;
      return on ? doc.documentElement.requestFullscreen!() : doc.exitFullscreen?.();
    },
    watch: (cb) => {
      const f = () => cb(!!doc.fullscreenElement);
      doc.addEventListener('fullscreenchange', f);
      f();
      return () => doc.removeEventListener('fullscreenchange', f);
    },
  };
}
