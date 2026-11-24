// @qalm/core is TypeScript: bundle its source for Node once per run and import it. The bundle is written inside the
// checkout being captured (SHOWCASE_ROOT, default: this repo), so its dependencies resolve from that checkout's
// node_modules; it re-exports that Yjs as `Y`, so the seed and core always share one Yjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const OUT = fileURLToPath(new URL('./out/', import.meta.url));
export const ROOT = resolve(process.env.SHOWCASE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)));
mkdirSync(OUT, { recursive: true });

let core;
export async function loadCore() {
  if (core) return core;
  const esbuild = require('esbuild');
  const dir = join(ROOT, 'node_modules', '.cache', 'qalm-showcase');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'entry.mjs');
  const src = join(ROOT, 'packages', 'core', 'src', 'index.ts').replace(/\\/g, '/');
  writeFileSync(entry, `export * from '${src}';\nexport * as Y from 'yjs';\n`);
  const outfile = join(dir, 'core.mjs');
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile, logLevel: 'warning' });
  core = await import(pathToFileURL(outfile).href);
  return core;
}
