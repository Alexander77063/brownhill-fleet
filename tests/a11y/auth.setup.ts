import { test as setup } from '@playwright/test';
import { acceptLegalIfPrompted, DEMO_USERS, signIn } from './helpers';
import { writeAuthState } from './auth-state';

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
 *
 * The state is written through `writeAuthState`, which holds the directory
 * at 0700 and the file at 0600. That file holds the `bf_session` cookie —
 * a bearer credential for the persona's account — and the project already
 * insists that a secret on disk is 0600 in a directory that is 0700.
 */
setup('authenticate as the operator', async ({ page }) => {
  await signIn(page, DEMO_USERS.ops);
  await acceptLegalIfPrompted(page, '/ops');
  await writeAuthState(page, 'ops');
});

setup('authenticate as the accountant', async ({ page }) => {
  await signIn(page, DEMO_USERS.accounts);
  await acceptLegalIfPrompted(page, '/accounts');
  await writeAuthState(page, 'accounts');
});

setup('authenticate as the driver', async ({ page }) => {
  await signIn(page, DEMO_USERS.driver);
  await acceptLegalIfPrompted(page, '/driver');
  await writeAuthState(page, 'driver');
});

setup('authenticate as the investor', async ({ page }) => {
  await signIn(page, DEMO_USERS.investor);
  await acceptLegalIfPrompted(page, '/investor');
  await writeAuthState(page, 'investor');
});
