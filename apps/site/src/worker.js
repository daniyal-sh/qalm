// qalm.apollolearn.app: the landing page at / and the web app at /app/, both static assets. This script runs only for
// the app's routes (run_worker_first in wrangler.jsonc). A hard reload or a link like /app/notebook/<id> or
// /app/auth/email/verify?token=… has no file of its own, so it gets the app's index.html (the SPA fallback).
// Missing files (a last segment with an extension: .js, .wasm, …) stay 404, and nothing outside /app falls back to the app.
import { APP_BASE, isAppRoute } from './routes.js';

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404 || (request.method !== 'GET' && request.method !== 'HEAD')) return res;
    const url = new URL(request.url);
    if (!isAppRoute(url.pathname)) return res;
    // The app's shell is /app/ (its index.html; /app/index.html itself redirects there).
    return env.ASSETS.fetch(new Request(new URL(`${APP_BASE}/`, url), { method: request.method, headers: request.headers }));
  },
};
