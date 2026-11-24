// @qalm/core is TypeScript: bundle its source for Node once per run (dependencies such as yjs stay external, so the
// seed and core share one Yjs), then import it.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const OUT = fileURLToPath(new URL('./out/', import.meta.url));

let core;
export async function loadCore() {
  if (core) return core;
  const esbuild = require('esbuild');
  mkdirSync(OUT, { recursive: true });
  const outfile = `${OUT}core.mjs`;
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile,
    logLevel: 'warning',
  });
  core = await import(pathToFileURL(outfile).href);
  return core;
}
