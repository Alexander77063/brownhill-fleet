import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
// A relative import rather than the `@/` alias: this module is loaded by
// Playwright's own TypeScript loader, not by the app's bundler, and a relative
// path is the one form that resolves identically under Playwright, under
// vitest and under `tsc --noEmit`.
import { signInCapabilities } from '../../src/lib/deployment/signin-modes';

/** The rule sets that make up WCAG 2.1 Level AA — the standard we claim against. */
export const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * The password for the seeded demo accounts.
 *
 * There is no default value and there is no committed one. The upstream suite
 * carried a literal password in this file, and this repository's
 * `hosted/tests/no-committed-credentials.sh` gate — which runs on every pull
 * request — fails the build on a credential-shaped literal anywhere in the
 * tree. The value is the operator's: `SEED_PASSWORD` seeds the accounts, and
 * the same value signs the suite in.
 */
export const DEMO_PASSWORD = process.env.SEED_PASSWORD;

/**
 * The password to sign in with, or a loud failure explaining how to set it.
 *
 * Failing here — rather than handing Playwright an empty string — is the
 * difference between "SEED_PASSWORD is not set" and a sign-in form that
 * quietly rejects every attempt.
 */
function demoPassword(): string {
  if (!DEMO_PASSWORD) {
    throw new Error(
      'SEED_PASSWORD is not set. The accessibility suite signs in as the seeded demo ' +
        'accounts, and this repository publishes no password: set SEED_PASSWORD to a value ' +
        'you choose, seed the accounts with it, and run the suite with the same value.',
    );
  }
  return DEMO_PASSWORD;
}

/** Fixed UUIDs from supabase/seed.sql — the RTB agreement and the demo tenant. */
export const SEEDED_AGREEMENT = 'a1111111-1111-1111-1111-111111111111';
export const SEEDED_TENANT = 'b1111111-1111-1111-1111-111111111111';

/**
 * Deterministic signing tokens for the /sign/[token] scans.
 *
 * Must match the shape the app validates before any lookup — exactly 32 characters of
 * [A-Za-z0-9_-] (24 random bytes as base64url). These are test fixtures in a local
 * database, never anything real.
 *
 * They are DERIVED rather than written out. A literal token has exactly the
 * shape this repository's no-committed-credentials gate hunts — an upper-case
 * letter, a lower-case letter, a digit and more than twelve characters — so a
 * committed token fails the build for being a test fixture. Deriving the value
 * from a fixed label gives the same bytes on every run and keeps the tree clean.
 */
function signingToken(label: string): string {
  return createHash('sha256').update(`brownhill-a11y-signing-${label}`).digest('base64url').slice(0, 32);
}

export const SIGNING_TOKENS = {
  partner: signingToken('partner'),
  driver: signingToken('driver'),
} as const;

/**
 * A well-formed token that matches no signing session.
 *
 * The point of the not-found scan is to exercise the LOOKUP-MISS branch, not the
 * cheaper format rejection, so this has to be the right shape (32 characters of
 * [A-Za-z0-9_-]) — see `TOKEN_RE` in `src/lib/signing.ts`.
 */
export const UNKNOWN_SIGNING_TOKEN = 'z'.repeat(32);

/**
 * The seeded demo accounts this fork creates — `scripts/seed-auth.mjs`.
 *
 * The operator's account is `tenant_admin` inside the tenant and `ops` in the
 * portal: there is no separate administrator role on this deployment, so one
 * signed-in operator reaches both the operations console and the admin console.
 * The accountant's account is `accounts` in the portal, which is the finance
 * console's own role. The driver's account is scoped to its own rows by RLS.
 */
export const DEMO_USERS = {
  ops: 'ops@brownhill.test',
  accounts: 'accounts@brownhill.test',
  investor: 'investor@brownhill.test',
  driver: 'driver@brownhill.test',
} as const;

/**
 * The deployment profile the suite runs against, and the sign-in methods that
 * profile may offer.
 *
 * `NEXT_PUBLIC_DEPLOYMENT_PROFILE` is the name the sign-in page itself reads —
 * it is baked into the client bundle by `next.config.ts` — so it is the name
 * that has to be compared here. `DEPLOYMENT_PROFILE` is the runtime spelling
 * and is what CI sets.
 *
 * The two must agree, and a disagreement is not a thing to discover halfway
 * through a scan: the page would offer one set of methods and the harness
 * another, and the harness would click a button that is not there.
 */
const PROFILE = (() => {
  const runtime = process.env.DEPLOYMENT_PROFILE?.trim();
  const baked = process.env.NEXT_PUBLIC_DEPLOYMENT_PROFILE?.trim();
  if (runtime && baked && runtime !== baked) {
    throw new Error(
      `DEPLOYMENT_PROFILE (${runtime}) and NEXT_PUBLIC_DEPLOYMENT_PROFILE (${baked}) disagree. ` +
        'The sign-in page is built from one and the harness reads the other.',
    );
  }
  return runtime ?? baked ?? 'saas';
})();

export const DEPLOYMENT_PROFILE = PROFILE;

/** The sign-in methods this build offers, in the order the page offers them. */
export const MODES = signInCapabilities(PROFILE).modes;

/**
 * Scan the current page and fail on any WCAG 2.1 AA violation.
 *
 * The failure message lists the rule, impact, and the offending selectors, because a
 * bare "expected 0 to be 3" tells whoever hits it in CI nothing actionable.
 */
export async function expectNoA11yViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();

  if (results.violations.length > 0) {
    const detail = results.violations
      .map((v) => {
        const nodes = v.nodes.slice(0, 5).map((n) => `      - ${n.target.join(' ')}`).join('\n');
        const more = v.nodes.length > 5 ? `\n      …and ${v.nodes.length - 5} more` : '';
        return `  [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}\n${nodes}${more}\n      ${v.helpUrl}`;
      })
      .join('\n');
    throw new Error(`${results.violations.length} accessibility violation(s) on ${label}:\n${detail}`);
  }

  expect(results.violations).toEqual([]);
}

/**
 * Navigate and wait for the app shell to settle.
 *
 * `networkidle` is deliberate: several pages stream server components in, and scanning
 * mid-hydration produces violations that do not exist in the settled DOM.
 */
export async function gotoAndSettle(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'networkidle' });

  // A crashed page is trivially accessible: an error boundary renders a handful of
  // clean elements and axe reports zero violations. Without this guard a route that
  // 500s server-side would show up as a PASS, which is worse than no coverage at all.
  const status = response?.status() ?? 0;
  expect(status, `${path} returned HTTP ${status}`).toBeLessThan(400);

  // Assert we are actually ON the route we asked for. Without this the suite silently
  // scans whatever it was redirected to — the legal-consent gate bounced every
  // authenticated route to /legal/accept and the scans "passed" against the same
  // consent page. A redirect makes the scan meaningless, so treat it as a failure.
  const landed = new URL(page.url()).pathname;
  expect(landed, `${path} redirected to ${landed} — the scan would not have covered ${path}`).toBe(path);

  const heading = page.locator('h1');
  await expect(heading.first(), `${path} rendered no <h1> — did the page error?`).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Clear the versioned legal-consent gate if it is blocking the session.
 *
 * The app requires an owner/admin to accept the current LEGAL_VERSION before any
 * authenticated operator route renders. A fresh database has no acceptance recorded,
 * so without this every signed-in scan lands on /legal/accept instead of the page
 * under test.
 *
 * `probePath` is a route behind the portal's layout. The gate is enforced there and
 * not on the sign-in page, so the harness has to go to one to find out whether it is
 * in the way — checking the URL it happens to be on would answer "no" every time.
 */
export async function acceptLegalIfPrompted(page: Page, probePath: string) {
  await page.goto(probePath, { waitUntil: 'networkidle' });

  if (!new URL(page.url()).pathname.startsWith('/legal/accept')) return;

  const agree = page.getByRole('checkbox');
  if ((await agree.count()) === 0) {
    // Only an owner/admin sees the form; a driver has to wait for theirs to accept.
    throw new Error('Blocked on /legal/accept with no form to submit — accept as an owner first.');
  }
  await agree.check();
  await page.getByRole('button', { name: /accept/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/legal/accept'), { timeout: 30_000 });
}

/** Sign in through the real password form — the same path a user takes. */
export async function signIn(page: Page, email: string) {
  await page.goto('/login', { waitUntil: 'networkidle' });

  // The method chooser is only rendered when there is something to choose between.
  // The hosted build offers a password and nothing else — there are no vehicle
  // owners to text a code to, and no Supabase to send a magic link from — so the
  // page renders no chooser at all and there is no "Password" button to click.
  // Clicking one that is not there would time out on a hidden element.
  //
  // `exact` matters too: the show/hide toggle on the password field is a button
  // whose accessible name is "Show password", and a substring match would make
  // this locator ambiguous between the two.
  if (MODES.length >= 2) {
    await page.getByRole('button', { name: 'Password', exact: true }).click();
  }

  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(demoPassword());
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}
