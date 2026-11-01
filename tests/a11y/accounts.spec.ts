import { test } from '@playwright/test';
import { expectNoA11yViolations, gotoAndSettle } from './helpers';
import { ACCOUNTS_ROUTES } from './routes';

/**
 * The finance console.
 *
 * A separate portal with its own role, so it is scanned with its own signed-in
 * session: the accountant sees the accounting module through the narrower
 * permissions their membership carries, and a scan that used the operator's
 * session would never see the locked and unlocked states that a real
 * accountant meets.
 */
for (const [path, label] of ACCOUNTS_ROUTES) {
  test(`accounts: ${label} (${path})`, async ({ page }) => {
    await gotoAndSettle(page, path);
    await expectNoA11yViolations(page, path);
  });
}
