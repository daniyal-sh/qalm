import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            JWT_SECRET: 'test-secret-test-secret-test-secret-0123',
            PUBLIC_URL: 'https://qalm.test',
            WAKE_IDLE_MS: '300',
            WAKE_MIN_INTERVAL_MS: '800',
            WAIT_TIMEOUT_MS: '2500',
            MAX_ASSET_BYTES: '1024',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], testTimeout: 20000 },
  };
});
