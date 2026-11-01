// tests/unit/a11y-coverage.test.ts
//
// The accessibility coverage, counted rather than claimed.
//
// WHY THIS TEST EXISTS
// --------------------
// The accessibility statement on /accessibility said "36 pages tested in a
// real browser", the test plan said "55 axe checks in CI", and the product
// document said the axe pass was "a separate CI job" — none of which was
// true, and the numbers were not even about this product. They were about a
// different fork's product, copied with the documents.
//
// A number in a document that nothing computes is a number that drifts. This
// test computes the coverage from the SAME lists the Playwright specs scan
// (`tests/a11y/routes.ts`) and then checks four things:
//
//   1. every route the suite claims to scan is a route this app actually
//      serves — a typo in a route list is a silently missing scan;
//   2. every route this app serves is either scanned or explicitly excluded
//      with a reason — a new page that nobody scans is a silent gap;
//   3. the suite's list of routes this deployment closes agrees with the app's
//      own gate (`src/lib/deployment/gate.ts`) — the suite and the middleware
//      must not disagree about what is 404 here;
//   4. every document that publishes a coverage figure publishes the computed
//      one — the documents cannot drift from the suite without this failing.
//
// It is a unit test on purpose: it needs no browser, no database and no
// running app, so it belongs in the fast lane and holds the documents honest
// even when the browser pass cannot run.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathDisabled } from '../../src/lib/deployment/gate';
import {
  A11Y_PAGES,
  A11Y_SCANS,
  ACCOUNTS_ROUTES,
  ADMIN_ACCOUNTING_ROUTES,
  ADMIN_ROUTES,
  DRIVER_ROUTES,
  INVESTOR_ROUTES,
  isGatedOffRoute,
  OPS_ROUTES,
  PUBLIC_ROUTES,
  REDIRECTED_ROUTES,
  REFLOW_ROUTES,
} from '../a11y/routes';

const REPO_ROOT = process.cwd();
const APP_DIR = join(REPO_ROOT, 'src', 'app');

interface AppRoute {
  /** The URL path, with dynamic segments left as they are written. */
  path: string;
  /** True when any segment of the path comes from the database. */
  dynamic: boolean;
}

/** Every page the App Router serves, found by walking src/app. */
function appRoutes(dir: string = APP_DIR, prefix = '', dynamic = false): AppRoute[] {
  const found: AppRoute[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    // A route group — `(portal)` — does not appear in the URL.
    const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
    // A dynamic segment — `[id]` — comes from the database.
    const isDynamic = entry.name.startsWith('[') && entry.name.endsWith(']');

    const segment = isGroup ? null : entry.name;
    const nextPrefix = segment === null ? prefix : `${prefix}/${segment}`;
    const nextDynamic = dynamic || isDynamic;

    if (existsSync(join(dir, entry.name, 'page.tsx'))) {
      found.push({ path: nextPrefix || '/', dynamic: nextDynamic });
    }
    found.push(...appRoutes(join(dir, entry.name), nextPrefix, nextDynamic));
  }
  return found;
}

const STATIC_ROUTES = appRoutes()
  .filter((r) => !r.dynamic)
  .map((r) => r.path);

/** Every route the Playwright suite reaches, from the lists it scans. */
const SCANNED_ROUTES = new Set<string>([
  ...PUBLIC_ROUTES.map(([path]) => path),
  ...OPS_ROUTES.map(([path]) => path),
  ...ADMIN_ROUTES.map(([path]) => path),
  ...ADMIN_ACCOUNTING_ROUTES.map(([path]) => path),
  ...ACCOUNTS_ROUTES.map(([path]) => path),
  ...INVESTOR_ROUTES.map(([path]) => path),
  ...DRIVER_ROUTES.map(([path]) => path),
  ...REFLOW_ROUTES,
]);

/**
 * Pages this app serves that the suite deliberately does not scan, each with
 * the reason it cannot be.
 *
 * An entry here is a decision, not a gap. A page that is simply missing from
 * this list fails the completeness check below, which is the point: adding a
 * page to the product means deciding whether it is covered.
 */
const NOT_SCANNED: { path: string; reason: string }[] = [
  {
    path: '/setup',
    reason:
      'First-run setup. On the hosted profile it redirects to /login as soon as any ' +
      'account exists, so there is no page left to scan.',
  },
  {
    path: '/legal/accept',
    reason:
      'The consent gate. The auth setup reaches it and clears it — that IS the ' +
      'runtime check — but once the tenant has accepted, the page redirects to /ops ' +
      'and there is nothing left to scan.',
  },
];

describe('the accessibility coverage', () => {
  it('counts the pages and the scans it publishes', () => {
    expect(A11Y_PAGES).toBe(SCANNED_ROUTES.size + 3); // + the three signing pages
    expect(A11Y_SCANS).toBeGreaterThan(A11Y_PAGES); // the second passes over some pages
  });

  it('scans only routes this app actually serves', () => {
    const missing = [...SCANNED_ROUTES].filter((path) => !STATIC_ROUTES.includes(path));
    expect(missing, 'the suite scans routes the app does not serve').toEqual([]);
  });

  it('scans every page this app serves, or says why it does not', () => {
    const unexplained = STATIC_ROUTES.filter(
      (path) =>
        !SCANNED_ROUTES.has(path) &&
        !NOT_SCANNED.some((n) => n.path === path) &&
        !isGatedOffRoute(path) &&
        !(REDIRECTED_ROUTES as readonly string[]).includes(path),
    );
    expect(
      unexplained,
      'these pages are neither scanned nor explained — add them to a scan list, or to NOT_SCANNED with a reason',
    ).toEqual([]);
  });

  it('never scans a route this deployment closes or redirects', () => {
    for (const path of [...STATIC_ROUTES, ...(REDIRECTED_ROUTES as readonly string[])]) {
      if (!isGatedOffRoute(path) && !(REDIRECTED_ROUTES as readonly string[]).includes(path)) continue;
      expect(SCANNED_ROUTES.has(path), `${path} is closed on this deployment`).toBe(false);
    }
  });

  it('agrees with the app about which routes this deployment closes', () => {
    // The scan list carries its own copy of the gated prefixes. This is the
    // check that keeps it honest: the app's own gate is the authority, and
    // `isPathDisabled` is the same function the middleware calls.
    //
    // The profile is set for the duration of the call and restored afterwards,
    // because `deploymentProfile()` reads the environment on every call.
    const saved = process.env.DEPLOYMENT_PROFILE;
    process.env.DEPLOYMENT_PROFILE = 'hosted';
    try {
      for (const path of STATIC_ROUTES) {
        expect(
          isGatedOffRoute(path),
          `${path} — the suite's list of closed routes and the app's gate disagree`,
        ).toBe(isPathDisabled(path));
      }
    } finally {
      if (saved === undefined) delete process.env.DEPLOYMENT_PROFILE;
      else process.env.DEPLOYMENT_PROFILE = saved;
    }
  });

  it('publishes the same numbers in every document that states them', () => {
    const documents = [
      'docs/accessibility/README.md',
      'docs/accessibility/VPAT.md',
      'docs/accessibility/audit-2026-07-31.md',
      'docs/testing/test-plan.md',
      'docs/product/02-trd.md',
      'docs/product/README.md',
      'src/app/accessibility/page.tsx',
    ];
    for (const document of documents) {
      const text = readFileSync(join(REPO_ROOT, document), 'utf8');
      expect(text, `${document} does not state the number of axe scans`).toMatch(
        new RegExp(`\\b${A11Y_SCANS}\\b`),
      );
      expect(text, `${document} does not state the number of pages`).toMatch(
        new RegExp(`\\b${A11Y_PAGES}\\b`),
      );
    }
  });
});
