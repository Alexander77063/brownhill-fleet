import { defineConfig, devices } from '@playwright/test';

/**
 * Runtime accessibility testing (axe-core in a real browser).
 *
 * This is the pass the static checks explicitly could not do — see
 * docs/accessibility/README.md. It needs a running app AND a running database,
 * because every authenticated route is behind middleware.
 *
 * Against a local stack:
 *
 *   docker compose -f hosted/dev/docker-compose.yml up -d --build
 *   psql postgresql://postgres@127.0.0.1:55432/postgres -f supabase/seed.sql
 *   SEED_PASSWORD='choose-one' node scripts/seed-auth.mjs
 *   pnpm test:a11y
 *
 * Against a stack that is already up (CI does this — the compose stack is the
 * system under test, and the harness must not start a second one):
 *
 *   A11Y_BASE_URL=http://127.0.0.1:55431 pnpm test:a11y
 *
 * `A11Y_BASE_URL` also switches off the `webServer` block below: with it set,
 * the harness attaches to the app that is already running instead of starting
 * one of its own, which is the difference between testing the deployed build
 * and testing a second copy of it.
 *
 * Runs against a production build rather than `next dev`: the dev overlay injects
 * its own DOM, which pollutes the results.
 */
const PORT = 3100;
const EXTERNAL_BASE_URL = process.env.A11Y_BASE_URL?.trim();
const BASE_URL = EXTERNAL_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/a11y',
  // Accessibility findings are deterministic; a retry would only hide flake in the
  // harness itself, which we would rather see.
  retries: 0,
  // The scans share one app server and one database; parallel workers make failures
  // harder to attribute for no real speed win at this route count.
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/axe-results.json' }]],
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    // Cuts noise from the analytics/telemetry the app does not need under test.
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    // Seeds a signing session so the tokenised /sign route can be reached at all.
    { name: 'signing-setup', testMatch: /signing\.setup\.ts/ },
    {
      name: 'public',
      testMatch: /public\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Public, but token-gated — hence its own project and its own seeding step.
      name: 'sign',
      testMatch: /sign\.spec\.ts/,
      dependencies: ['signing-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'ops',
      testMatch: /ops\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'test-results/.auth/ops.json' },
    },
    {
      // The finance console: its own portal, so its own session.
      name: 'accounts',
      testMatch: /accounts\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'test-results/.auth/accounts.json' },
    },
    {
      name: 'driver',
      testMatch: /driver\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'test-results/.auth/driver.json' },
    },
    {
      // The investor portal: its own portal, so its own session.
      name: 'investor',
      testMatch: /investor\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'test-results/.auth/investor.json' },
    },
    {
      // WCAG 1.4.10 Reflow — 320 CSS px wide, the criterion's own threshold.
      name: 'reflow',
      testMatch: /reflow\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 320, height: 720 },
        storageState: 'test-results/.auth/ops.json',
      },
    },
  ],
  // Only when this harness is responsible for the app. With A11Y_BASE_URL set,
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
