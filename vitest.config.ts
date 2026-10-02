import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // RLS tests share one Postgres connection pool; run serially to avoid
    // exhausting the local Supabase connection limit.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
