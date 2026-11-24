// Which paths belong to the web app (kept out of worker.js: a Worker module's named exports must be handlers).
export const APP_BASE = '/app';

/** True for a path the app's router handles: /app or under /app/, with no file extension in its last segment. */
export function isAppRoute(pathname) {
  if (pathname !== APP_BASE && !pathname.startsWith(`${APP_BASE}/`)) return false;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !/\.[A-Za-z0-9]{1,8}$/.test(last);
}
