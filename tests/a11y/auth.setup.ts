import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { acceptLegalIfPrompted, DEMO_USERS, signIn } from './helpers';

/**
 * Mint a signed-in session per persona once, and reuse it across every scan.
 *
 * Uses the real login form rather than forging a cookie, so the local HS256
 * session cookie stays the app's problem and not this harness's.
 *
 * The order matters. The operations and admin consoles are behind a
 * tenant-wide legal-consent gate, and only a member who holds
 * `tenant.settings` can clear it. The operator's account is that member, so it
 * signs in first and accepts on the organisation's behalf; the finance and
 * driver personas then inherit a tenant that has already accepted.
 */
setup('authenticate as the operator', async ({ page }) => {
  mkdirSync('test-results/.auth', { recursive: true });
  await signIn(page, DEMO_USERS.ops);
  await acceptLegalIfPrompted(page, '/ops');
  await page.context().storageState({ path: 'test-results/.auth/ops.json' });
});

setup('authenticate as the accountant', async ({ page }) => {
  mkdirSync('test-results/.auth', { recursive: true });
  await signIn(page, DEMO_USERS.accounts);
  await acceptLegalIfPrompted(page, '/accounts');
  await page.context().storageState({ path: 'test-results/.auth/accounts.json' });
});

setup('authenticate as the driver', async ({ page }) => {
  mkdirSync('test-results/.auth', { recursive: true });
  await signIn(page, DEMO_USERS.driver);
  await acceptLegalIfPrompted(page, '/driver');
  await page.context().storageState({ path: 'test-results/.auth/driver.json' });
});

setup('authenticate as the investor', async ({ page }) => {
  mkdirSync('test-results/.auth', { recursive: true });
  await signIn(page, DEMO_USERS.investor);
  await acceptLegalIfPrompted(page, '/investor');
  await page.context().storageState({ path: 'test-results/.auth/investor.json' });
});
