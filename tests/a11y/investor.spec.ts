import { test } from '@playwright/test';
import { expectNoA11yViolations, gotoAndSettle } from './helpers';
import { INVESTOR_ROUTES } from './routes';

/**
 * The investor portal.
 *
 * Scanned with the investor's own session: the page reads the PII-free view
 * the database exposes to investors, so what an investor meets is not what the
 * operator sees, and a scan made with the wrong session would prove nothing
 * about it.
 */
for (const [path, label] of INVESTOR_ROUTES) {
  test(`investor: ${label} (${path})`, async ({ page }) => {
    await gotoAndSettle(page, path);
    await expectNoA11yViolations(page, path);
  });
}
