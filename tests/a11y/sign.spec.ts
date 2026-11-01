import { expect, test } from '@playwright/test';
import {
  expectNoA11yViolations,
  gotoAndSettle,
  SIGNING_TOKENS,
  UNKNOWN_SIGNING_TOKEN,
} from './helpers';

/**
 * The public agreement-signing route.
 *
 * Reachable only with a valid token, which is why it was absent from the runtime pass
 * until now — the most safety-critical screen in the product was verified statically
 * only. It also renders its own stylesheet rather than the app shell, so nothing here
 * inherits the global focus ring or heading treatment; it has to be checked on its own.
 */
test('sign: partner review step', async ({ page }) => {
  await gotoAndSettle(page, `/sign/${SIGNING_TOKENS.partner}`);
  await expect(page.getByRole('heading', { name: 'Vehicle Rental Agreement' })).toBeVisible();
  await expectNoA11yViolations(page, '/sign/[partner-token]');
});

test('sign: driver signing step, drawn-signature default', async ({ page }) => {
  await gotoAndSettle(page, `/sign/${SIGNING_TOKENS.driver}`);
  await expect(page.getByRole('heading', { name: 'Vehicle Rental Agreement' })).toBeVisible();
  await expectNoA11yViolations(page, '/sign/[driver-token]');
});

test('sign: the typed-signature alternative is keyboard-operable and accessible', async ({ page }) => {
  await gotoAndSettle(page, `/sign/${SIGNING_TOKENS.driver}`);

  // WCAG 2.1.1 — this path exists so a keyboard or switch user can execute a contract
  // at all. Drive it the way they would: no clicks on the canvas, keyboard only.
  const typeIt = page.getByRole('button', { name: 'Type it' });
  await expect(typeIt).toBeVisible();
  await typeIt.click();

  const typed = page.getByLabel('Type your signature');
  await expect(typed).toBeVisible();
  await typed.fill('Samuel Okonkwo');
  await expect(typed).toHaveValue('Samuel Okonkwo');

  // The mode toggle must expose its state, not just look pressed.
  await expect(typeIt).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Draw it' })).toHaveAttribute('aria-pressed', 'false');

  await expectNoA11yViolations(page, '/sign/[driver-token] (typed signature)');
});

test('sign: an unknown token renders an accessible not-found page', async ({ page }) => {
  // Deliberately a VALID-shaped token with no matching session, so this exercises the
  // lookup-miss branch rather than the cheaper format rejection.
  await gotoAndSettle(page, `/sign/${UNKNOWN_SIGNING_TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Link not found' })).toBeVisible();
  await expectNoA11yViolations(page, '/sign/[unknown-token]');
});
