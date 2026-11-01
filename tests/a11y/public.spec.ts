import { expect, test } from '@playwright/test';
import { expectNoA11yViolations, gotoAndSettle, MODES } from './helpers';
import { PUBLIC_ROUTES } from './routes';

/**
 * The unauthenticated surface — the marketing, sign-in and legal pages.
 *
 * A page that 404s is not covered: `gotoAndSettle` fails on any route that
 * answers with an error status, because a 404 page renders a handful of clean
 * elements and axe reports nothing wrong with it. A scan of a closed route
 * would be a scan of an error page presented as coverage.
 */
for (const [path, label] of PUBLIC_ROUTES) {
  test(`public: ${label} (${path})`, async ({ page }) => {
    await gotoAndSettle(page, path);
    await expectNoA11yViolations(page, path);
  });
}

test('public: sign-in error is announced in a live region', async ({ page }) => {
  await gotoAndSettle(page, '/login');

  // The method chooser only exists when there is a choice to make. This build
  // offers one method — a password — so the chooser is not rendered and the
  // password form is already the one on screen.
  if (MODES.length >= 2) {
    await page.getByRole('button', { name: 'Password', exact: true }).click();
  }

  await page.getByLabel('Email address').fill('nobody@example.test');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // WCAG 4.1.3 — the failure must reach assistive tech without focus moving.
  // Scoped to the page's own content: Next.js renders its route announcer as a
  // second role="alert" node, which would otherwise make this locator ambiguous.
  const alert = page.locator('#main-content').getByRole('alert');
  await alert.waitFor({ state: 'attached', timeout: 20_000 });
  await expect(alert).toContainText(/\S/, { timeout: 20_000 });
  await expectNoA11yViolations(page, '/login (error state)');
});
