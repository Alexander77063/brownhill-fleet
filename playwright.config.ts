import { defineConfig, devices } from '@playwright/test';

/**
 * Runtime accessibility testing (axe-core in a real browser).
 *
 * This is the pass the static checks explicitly could not do — see
 * docs/accessibility/README.md. It needs a running app AND a running local
 * Supabase, because every authenticated route is behind middleware.
 *
 *   supabase start
 *   node scripts/seed-auth.mjs
 *   pnpm build
 *   pnpm test:axe
 *
 * Runs against a production build rather than `next dev`: the dev overlay injects
 * its own DOM, which pollutes the results.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
      name: 'driver',
      testMatch: /driver\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'test-results/.auth/driver.json' },
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
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
