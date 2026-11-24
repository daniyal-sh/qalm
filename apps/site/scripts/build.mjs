// Builds dist/ for the site Worker:
//   dist/        the landing page (public/)
//   dist/app/    the Expo web export, built with the base path /app
// The app reads EXPO_PUBLIC_QALM_SERVER_URL at build time: set it for staging or production (see handover.md).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(site, '..', 'app');
const dist = join(site, 'dist');
const require = createRequire(join(app, 'package.json'));
const expoCli = join(dirname(require.resolve('expo/package.json')), 'bin', 'cli');

if (!process.env.EXPO_PUBLIC_QALM_SERVER_URL) console.warn('site: EXPO_PUBLIC_QALM_SERVER_URL is not set, so the web app is offline-only.');

function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: app, stdio: 'inherit', env: { ...process.env, QALM_WEB_BASE_URL: '/app' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync(dist, { recursive: true, force: true });
run([join(app, 'scripts', 'web-assets.mjs')]);
// --clear: Metro's cache must not hand back modules transformed for the root base path (export:web, desktop).
run([expoCli, 'export', '-p', 'web', '--clear', '--output-dir', join(dist, 'app')]);
if (!existsSync(join(dist, 'app', 'index.html'))) throw new Error('site: the web export has no index.html');
cpSync(join(site, 'public'), dist, { recursive: true });
console.log(`site: ${dist} (landing at /, app at /app/)`);
