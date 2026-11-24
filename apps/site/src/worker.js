// qalm.apollolearn.app: the landing page at / and the web app at /app/, both static assets, plus the installers at
// /download/windows and /download/android. This script runs only for those routes (run_worker_first in wrangler.jsonc).
//
// /app: a hard reload or a link like /app/notebook/<id> or /app/auth/email/verify?token=… has no file of its own, so it
// gets the app's index.html (the SPA fallback). Missing files (a last segment with an extension: .js, .wasm, …) stay
// 404, and nothing outside /app falls back to the app.
//
// /download/*: the installers are too big for static assets (25 MiB), so they stream from R2 (the DOWNLOADS bucket),
// with ranges for resumed downloads. A missing installer gets a friendly "not available yet" page instead of a raw 404.
import { APP_BASE, UNAVAILABLE_PAGE, byteRange, downloadFor, isAppRoute } from './routes.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const dl = downloadFor(url.pathname);
    if (dl) return download(request, env, dl, url);

    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404 || (request.method !== 'GET' && request.method !== 'HEAD')) return res;
    if (!isAppRoute(url.pathname)) return res;
    // The app's shell is /app/ (its index.html; /app/index.html itself redirects there).
    return env.ASSETS.fetch(new Request(new URL(`${APP_BASE}/`, url), { method: request.method, headers: request.headers }));
  },
};

async function download(request, env, dl, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const bucket = env.DOWNLOADS;
  if (!bucket) return unavailable(request, env, dl, url);

  const head = request.method === 'HEAD';
  let obj;
  try {
    obj = head ? await bucket.head(dl.key) : await bucket.get(dl.key, { range: request.headers, onlyIf: request.headers });
  } catch {
    // An unsatisfiable Range (past the end of the file).
    const meta = await bucket.head(dl.key);
    if (!meta) return unavailable(request, env, dl, url);
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
  }
  if (!obj) return unavailable(request, env, dl, url);

  const headers = new Headers({
    'Content-Type': dl.contentType,
    'Content-Disposition': `attachment; filename="${dl.filename}"`,
    'Accept-Ranges': 'bytes',
    // Installers are replaced in place: always revalidate (cheap with the ETag).
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ETag: obj.httpEtag,
  });
  if (obj.uploaded) headers.set('Last-Modified', obj.uploaded.toUTCString());

  // A conditional GET that matched (If-None-Match / If-Modified-Since): R2 hands back the metadata without a body.
  if (!head && !('body' in obj)) return new Response(null, { status: 304, headers });

  const size = obj.size;
  const range = !head && request.headers.has('Range') ? byteRange(obj.range, size) : null;
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  return new Response(head ? null : obj.body, { status: 200, headers });
}

/** The landing's "not available yet" page, naming the platform, with a 404 so nothing caches it as the installer. */
async function unavailable(request, env, dl, url) {
  const page = await env.ASSETS.fetch(new Request(new URL(UNAVAILABLE_PAGE, url)));
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (!page.ok) return new Response(`The ${dl.label} download isn't available yet.`, { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
  const html = (await page.text()).replaceAll('<span data-platform>This download</span>', `<span data-platform>The ${dl.label} download</span>`);
  return new Response(request.method === 'HEAD' ? null : html, { status: 404, headers });
}
