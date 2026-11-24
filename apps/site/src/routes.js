// Which paths belong to the web app and the downloads (kept out of worker.js: a Worker module's named exports must be
// handlers).
export const APP_BASE = '/app';

/** True for a path the app's router handles: /app or under /app/, with no file extension in its last segment. */
export function isAppRoute(pathname) {
  if (pathname !== APP_BASE && !pathname.startsWith(`${APP_BASE}/`)) return false;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !/\.[A-Za-z0-9]{1,8}$/.test(last);
}

/**
 * The installers, streamed from the DOWNLOADS bucket (R2). The lead uploads them to these keys; the filename is what
 * the browser saves.
 */
export const DOWNLOADS = {
  windows: {
    key: 'windows/qalm-setup.exe',
    filename: 'qalm-setup.exe',
    contentType: 'application/vnd.microsoft.portable-executable',
    label: 'Windows',
  },
  android: {
    key: 'android/qalm.apk',
    filename: 'qalm.apk',
    contentType: 'application/vnd.android.package-archive',
    label: 'Android',
  },
};

/** The download for /download/windows or /download/android (a trailing slash is fine), else null. */
export function downloadFor(pathname) {
  const m = /^\/download\/([a-z]+)\/?$/.exec(pathname);
  return (m && Object.hasOwn(DOWNLOADS, m[1]) && DOWNLOADS[m[1]]) || null;
}

/** The friendly page shown when an installer isn't in the bucket yet (a landing asset, see landing/build.mjs). */
export const UNAVAILABLE_PAGE = '/download/unavailable';

/** R2's parsed range ({offset, length} | {offset} | {suffix}) as inclusive byte positions. */
export function byteRange(r, size) {
  if (!r) return null;
  if ('suffix' in r && r.suffix !== undefined) return { start: Math.max(0, size - r.suffix), end: size - 1 };
  const start = r.offset ?? 0;
  const end = r.length !== undefined ? Math.min(size - 1, start + r.length - 1) : size - 1;
  return { start, end };
}
