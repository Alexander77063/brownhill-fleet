import { defineConfig, devices } from '@playwright/test';

/**
 * The live handover pass: the invitation flows, driven through a real browser
 * against the deployment that is actually running.
 *
 * WHY IT IS ITS OWN CONFIG
 * -------------------------
 * The accessibility pass (`playwright.config.ts`) SCANS pages: it opens them,
 * runs axe over them and looks for violations. It never changes anything.
 *
 * This pass CHANGES things — it adds a colleague and a driver to the demo
 * tenant, signs in as both of them, and cleans up after itself. It is a
 * different kind of test against the same deployment, with different
 * requirements (it needs a seeded operator and a password, not just a signed
 * session), and it must not be able to run where the scan cannot.
 *
 * So it is a separate config with its own directory, its own project and its
 * own command. The accessibility config is untouched by this file, and this
 * file cannot accidentally pick up a scan.
 *
 * AGAINST A LOCAL STACK
 * ---------------------
 *   docker compose -f hosted/dev/docker-compose.yml up -d --build
 *   bash hosted/scripts/wait-for-bootstrap.sh --compose-file hosted/dev/docker-compose.yml
 *   docker compose -f hosted/dev/docker-compose.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/seed.sql
 *   SEED_PASSWORD='choose-one' node scripts/seed-auth.mjs
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
 *   SEED_PASSWORD='choose-one' \
 *   LIVE_BASE_URL=http://127.0.0.1:55431 pnpm exec playwright test -c playwright.live.config.ts
 *
 * `LIVE_BASE_URL` (or `A11Y_BASE_URL`) points the harness at the deployment
 * that is already running. Without it the harness starts its own copy — which
 * is a DIFFERENT build from the one in the container, and so is not the
 * deployment under test.
 */
const EXTERNAL_BASE_URL = (
  process.env.LIVE_BASE_URL?.trim() || process.env.A11Y_BASE_URL?.trim()
);
const PORT = 3101;
const BASE_URL = EXTERNAL_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/live',
  // The pass adds people to a tenant. A retry would add them twice, and the
  // second attempt would fail for the wrong reason — the account already
  // exists. A failure is a failure.
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'live',
      testMatch: /.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only when this harness is responsible for the app. With a base URL set,
  // the app is somebody else's — the compose stack's — and starting a second
  // one would test a different build than the one under test.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next start -p ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
