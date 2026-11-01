import { test } from '@playwright/test';
import { expectNoA11yViolations, gotoAndSettle } from './helpers';
import { DRIVER_ROUTES } from './routes';

/** The driver portal — mostly mobile use, and the surface a non-employee touches. */
for (const [path, label] of DRIVER_ROUTES) {
  test(`driver: ${label} (${path})`, async ({ page }) => {
    await gotoAndSettle(page, path);
    await expectNoA11yViolations(page, path);
  });
}
