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
            AI_LIVE_TTL_MS: '1200',
            MAX_ASSET_BYTES: '1024',
            MAX_USER_STORAGE_BYTES: '1500',
            // Pin anything a developer's local .dev.vars might set (vitest-pool-workers reads it), so tests are hermetic.
            MAGIC_LINK_URL: 'https://qalm.example/app/auth/email/verify',
            EMAIL_PROVIDER: 'console',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], testTimeout: 20000 },
  };
});
