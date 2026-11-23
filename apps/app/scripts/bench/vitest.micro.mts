import { defineConfig } from 'vitest/config';

// Micro-benchmarks (not part of `pnpm test`): `pnpm --filter @qalm/app bench:micro`.
export default defineConfig({
  test: { include: ['scripts/bench/micro.test.ts'], environment: 'node', testTimeout: 120000 },
});
