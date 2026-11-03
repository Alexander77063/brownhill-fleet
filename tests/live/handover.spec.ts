// tests/live/handover.spec.ts
//
// The two invitation flows, driven through a real browser against the real
// deployment.
//
// WHY THIS FILE EXISTS
// --------------------
// Both invitation flows have an integration test that proves the DATABASE is
// right: the account exists, the credential is there, the membership is there,
// the driver is linked. That is a good gate, and it is not the same thing.
//
// The thing a customer actually trips over is the ten seconds AFTER the
// button. The colleague is added — does the operator see anything? Do they
// get a password they can read out? Can the person actually sign in with it?
// Does the panel say what happened, in the page, next to the button?
//
// Both of those failed, in the same way, and neither integration test could
// see it:
//
//   * the driver invite wrote to a column that does not exist on this
//     deployment, so the invite threw halfway and the driver was left with an
//     account nobody could reach;
//   * on both flows the temporary password lived only inside an email, and
//     a self-hosted box normally has no email provider — so the password
//     reached nobody and the operator had no way to help.
//
// So this file drives the ACTUAL page, with the ACTUAL operator, and then
// signs in as the person who was just invited, with the password that was on
// the screen. If the panel shows nothing, or shows the wrong thing, or the
// new account cannot sign in, this file fails.
//
// IT NEEDS A RUNNING DEPLOYMENT AND A SEEDED DATABASE
// ----------------------------------------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//   SEED_PASSWORD='choose-one' \
//   A11Y_BASE_URL=http://127.0.0.1:55431 pnpm exec playwright test -c playwright.live.config.ts
//
// The seeded operator is `ops@brownhill.test`, and `SEED_PASSWORD` is the
// password `scripts/seed-auth.mjs` gave the demo accounts.
//
// IT LEAVES NOTHING BEHIND
// ------------------------
// Every account it creates is removed again, in the same run, whether the test
// passed or failed. A live test that leaves a colleague and a driver in the
// customer's database is debris the customer will find.

import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
// A relative import rather than the `@/` alias: this module is loaded by
// Playwright's own TypeScript loader, not by the app's bundler.
import { signInCapabilities } from '../../src/lib/deployment/signin-modes';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const SEED_PASSWORD = process.env.SEED_PASSWORD?.trim();

/** The seeded operator. `scripts/seed-auth.mjs` makes this a `tenant_admin`. */
const OPERATOR = 'ops@brownhill.test';

const PROFILE = process.env.DEPLOYMENT_PROFILE?.trim()
  ?? process.env.NEXT_PUBLIC_DEPLOYMENT_PROFILE?.trim()
  ?? 'saas';

let sql: ReturnType<typeof postgres> | null = null;

/** Every address this run created, so the cleanup can find them. */
const createdEmails = new Set<string>();

/**
 * Sign in through a password form, at whichever sign-in page is given.
 *
 * The driver's page (`/driver/login`) and the app's own (`/login`) are two
 * different forms with two different labels — "Email" and "Email address" —
 * so the locator matches on the beginning of the label rather than pinning
 * one of them.
 */
async function signInAt(page: Page, path: string, email: string, password: string) {
  await page.goto(path, { waitUntil: 'networkidle' });

  // The method chooser is only rendered when there is something to choose
  // between. The hosted build offers a password and nothing else, so the page
  // renders no chooser and there is no "Password" button to click.
  if (signInCapabilities(PROFILE).modes.length >= 2) {
    await page.getByRole('button', { name: 'Password', exact: true }).click();
  }

  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

/**
 * The temporary password the panel is showing.
 *
 * It is the FIRST `<code>` inside the status region: the password comes first
 * in the DOM, and the only other code elements there are the path to the
 * profile page and the sign-in link, both of which come after it.
 */
async function readShownPassword(page: Page): Promise<string> {
  const status = page.locator('[role="status"]');
  await expect(status, 'the panel did not report a result').toBeVisible({ timeout: 30_000 });
  const password = (await status.locator('code').first().innerText()).trim();
  return password;
}

test.beforeAll(async () => {
  if (!DATABASE_URL || !SEED_PASSWORD) {
    throw new Error(
      'The live handover pass needs DATABASE_URL and SEED_PASSWORD. It drives a real ' +
        'deployment and signs in as a real seeded operator; without them there is nothing ' +
        'to drive.',
    );
  }
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
});

test.afterAll(async () => {
  if (!sql) return;
  // The accounts go before the drivers, and the profiles before the accounts:
  // `profiles.driver_id` points at a driver, and the profiles point at the
  // accounts.
  if (createdEmails.size > 0) {
    const emails = [...createdEmails];
    await sql`
      delete from public.tenant_memberships
       where user_id in (select id from auth.users where email = any(${emails}::text[]))
    `;
    await sql`
      delete from public.profiles
       where id in (select id from auth.users where email = any(${emails}::text[]))
    `;
    await sql`
      delete from auth.local_credentials
       where user_id in (select id from auth.users where email = any(${emails}::text[]))
    `;
    await sql`delete from auth.users where email = any(${emails}::text[])`;
    await sql`delete from public.drivers where email = any(${emails}::text[])`;
  }
  await sql.end({ timeout: 5 });
});

test.describe('the invitation flows, on the deployed build', () => {
  test('an operator adds a colleague, and the colleague can sign in with the password on screen', async ({ page, browser }) => {
    const email = `live-member-${randomUUID().slice(0, 8)}@brownhill.test`;
    createdEmails.add(email);

    // ── the operator ──────────────────────────────────────────────────────
    await signInAt(page, '/login', OPERATOR, SEED_PASSWORD!);

    await page.goto('/admin', { waitUntil: 'networkidle' });
    // Scoped to the form that has the button. The admin page also carries a
    // role control per member row, and a bare `getByLabel('Role')` would match
    // those too — Playwright's strict mode would refuse the ambiguity rather
    // than pick one.
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Add member', exact: true }),
    });
    // The accessible name of this field is the whole label, hint included —
    // "Email we'll create their login. On this deployment you are given a
    // password to give them." — because the hint sits inside the `<label>`.
    // So the label is matched by its start, not exactly.
    await form.getByLabel(/^email/i).fill(email);
    // The role is matched by its ACCESSIBLE name rather than by its label:
    // the `<label>` wraps the `<select>`, so the label's raw text is
    // "Roleownertenant_adminmd…" — every option in it — while the name a
    // screen reader announces is exactly "Role". Matching by role and name
    // is both the correct locator and the assertion that the name is right.
    await form.getByRole('combobox', { name: 'Role', exact: true }).selectOption('ops');
    await form.getByRole('button', { name: 'Add member', exact: true }).click();

    // ── the panel says what happened, and shows the password ──────────────
    const status = page.locator('[role="status"]');
    await expect(status).toContainText('Member added', { timeout: 30_000 });
    await expect(status).toContainText(email);

    const password = await readShownPassword(page);
    expect(password.length, 'the panel showed no password to read out').toBeGreaterThanOrEqual(16);
    expect(password, 'the panel showed a path, not a password').not.toContain('/');

    // ── and the colleague can actually get in with it ─────────────────────
    const colleague = await browser.newContext();
    const colleaguePage = await colleague.newPage();
    try {
      await signInAt(colleaguePage, '/login', email, password);
      await expect(colleaguePage.locator('h1').first()).toBeVisible({ timeout: 30_000 });
      expect(
        new URL(colleaguePage.url()).pathname,
        'the new colleague was not put in the operations desk',
      ).toBe('/ops');
    } finally {
      await colleague.close();
    }
  });

  test('an operator invites a driver, and the driver can sign in with the password on screen', async ({ page, browser }) => {
    const email = `live-driver-${randomUUID().slice(0, 8)}@brownhill.test`;
    const name = 'Live Handover Driver';
    createdEmails.add(email);

    await signInAt(page, '/login', OPERATOR, SEED_PASSWORD!);

    await page.goto('/ops/drivers', { waitUntil: 'networkidle' });
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Invite driver', exact: true }),
    });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Login email', { exact: true }).fill(email);
    await form.getByRole('button', { name: 'Invite driver', exact: true }).click();

    // ── the panel says what happened, and shows the password ──────────────
    const status = page.locator('[role="status"]');
    await expect(status).toContainText('Driver invited', { timeout: 30_000 });
    await expect(status).toContainText(email);

    const password = await readShownPassword(page);
    expect(password.length, 'the panel showed no password to read out').toBeGreaterThanOrEqual(16);
    expect(password, 'the panel showed a path, not a password').not.toContain('/');

    // The operator is told where to send them, and it is a real page.
    await expect(status).toContainText('/driver/login');

    // ── and the driver can actually get in with it ────────────────────────
    const driver = await browser.newContext();
    const driverPage = await driver.newPage();
    try {
      await signInAt(driverPage, '/driver/login', email, password);
      await expect(driverPage.locator('h1').first()).toBeVisible({ timeout: 30_000 });
      expect(
        new URL(driverPage.url()).pathname,
        'the new driver was not put in the driver portal',
      ).toBe('/driver');
    } finally {
      await driver.close();
    }
  });

  test('the operator can see the driver they just invited in the drivers list', async ({ page }) => {
    const email = `live-listed-${randomUUID().slice(0, 8)}@brownhill.test`;
    const name = 'Live Listed Driver';
    createdEmails.add(email);

    await signInAt(page, '/login', OPERATOR, SEED_PASSWORD!);

    await page.goto('/ops/drivers', { waitUntil: 'networkidle' });
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Invite driver', exact: true }),
    });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Login email', { exact: true }).fill(email);
    await form.getByRole('button', { name: 'Invite driver', exact: true }).click();
    await expect(page.locator('[role="status"]')).toContainText('Driver invited', { timeout: 30_000 });

    // The invite is not just an account — the driver is on the books, and the
    // operator can see them on the same page they invited them from.
    //
    // The name is looked for as a LINK inside the table, because the invite
    // form's own dropdown also carries every driver's name: a plain text
    // match finds the `<option>` in the select, which is never visible, and
    // the assertion would pass or fail for the wrong reason.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(
      page.locator('table').getByRole('link', { name, exact: true }),
      'the invited driver is not in the drivers list',
    ).toBeVisible({ timeout: 30_000 });
  });
});
