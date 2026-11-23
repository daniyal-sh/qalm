// Dev launcher.
//   pnpm --filter @qalm/desktop dev            → Electron on the Expo web dev server (run `pnpm --filter @qalm/app web` first;
//                                               QALM_DEV_URL overrides http://localhost:8081)
//   pnpm --filter @qalm/desktop dev:export     → fresh `expo export -p web`, then Electron on apps/app/dist over app://
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };

if (process.argv.includes('--export')) {
  const r = spawnSync('pnpm', ['--filter', '@qalm/app', 'export:web'], {
    stdio: 'inherit',
    shell: true,
    env: { ...env, NODE_OPTIONS: env.NODE_OPTIONS || '--max-old-space-size=4096' },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  delete env.QALM_DEV_URL;
} else {
  env.QALM_DEV_URL ||= 'http://localhost:8081';
}

const child = spawn(electron, [join(here, '..')], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
