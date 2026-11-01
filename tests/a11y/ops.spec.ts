import { expect, test } from '@playwright/test';
import { expectNoA11yViolations, gotoAndSettle } from './helpers';
import { ADMIN_ACCOUNTING_ROUTES, ADMIN_ROUTES, OPS_ROUTES } from './routes';

/**
 * The operator's own surfaces — the operations console, the admin console and
 * the admin side of the accounting module.
 *
 * One signed-in operator covers all three: on this deployment the operator's
 * account holds the `tenant_admin` membership, so there is no separate
 * administrator to sign in as.
 */
const OPERATOR_ROUTES = [...OPS_ROUTES, ...ADMIN_ROUTES, ...ADMIN_ACCOUNTING_ROUTES];

for (const [path, label] of OPERATOR_ROUTES) {
  test(`ops: ${label} (${path})`, async ({ page }) => {
    await gotoAndSettle(page, path);
    await expectNoA11yViolations(page, path);
  });
}

test('ops: skip link is the first focusable element and moves focus to main content', async ({ page }) => {
  await gotoAndSettle(page, '/ops');

  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeAttached();

  // WCAG 2.4.1 — it has to come before the navigation in tab order. Asserted from the
  // DOM rather than by pressing Tab: where focus starts in a headless browser is not
  // guaranteed, which made the keypress version flaky in CI.
  const isFirstFocusable = await page.evaluate(() => {
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
    ).filter((el) => el.tabIndex >= 0 && el.offsetParent !== null || el.classList.contains('skip-link'));
    return focusable[0]?.classList.contains('skip-link') ?? false;
  });
  expect(isFirstFocusable, 'the skip link must precede the navigation in tab order').toBe(true);

  // And activating it must actually move focus into the main region, which is what
  // makes it useful rather than decorative.
  await skip.focus();
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('ops: a table caption names the table without disturbing layout', async ({ page }) => {
  await gotoAndSettle(page, '/ops/fleet');

  // Data-dependent: with an empty fleet the page renders an empty state and there is
  // no table to assert about. Skip loudly rather than pass vacuously.
  const tableCount = await page.locator('table').count();
  test.skip(tableCount === 0, 'No fleet rows on this instance — no table to check.');

  // The caption is visually hidden but must still be in the accessibility tree.
  const caption = page.locator('table caption').first();
  await expect(caption).toHaveText(/\S/);

  // sr-only uses position:absolute; confirm it did not collapse the table it labels.
  const tableBox = await page.locator('table').first().boundingBox();
  expect(tableBox?.width ?? 0).toBeGreaterThan(200);
  expect(tableBox?.height ?? 0).toBeGreaterThan(40);
});
