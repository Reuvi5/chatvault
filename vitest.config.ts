import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@chatvault/protocol': r('./packages/protocol/src/index.ts'),
      '@chatvault/crypto': r('./packages/crypto/src/index.ts'),
      '@chatvault/parser': r('./packages/parser/src/index.ts'),
      '@chatvault/client': r('./packages/client/src/index.ts'),
      '@': r('./apps/web/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'apps/web/tests/**/*.test.ts'],
    // Argon2id with production parameters is intentionally slow.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
