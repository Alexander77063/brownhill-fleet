// tests/unit/user-test-coverage.test.ts
//
// The user test's coverage, counted rather than claimed.
//
// WHY THIS TEST EXISTS
// --------------------
// The user test drives every page and every API route on the deployment a
// customer operates. The list of routes it drives lives in
// `hosted/tests/user-test/manifest.mjs`, and that list is hand-written — so
// it drifts. A route added to the app and forgotten in the manifest is a
// screen nobody opened during the handover, and nobody finds out until the
// customer clicks it.
//
// The accessibility coverage already has a test like this one
// (`tests/unit/a11y-coverage.test.ts`), and it exists because the published
// accessibility figures were copied from a different fork's product and
// drifted. The same failure mode applies here, one layer over: not a number
// that drifts, but a LIST.
//
// So this test computes the coverage from the SAME manifest the sweep drives,
// and then checks:
//
//   1. every page the app serves is either in the manifest, or closed by the
//      deployment gate, or listed as deliberately not driven with a reason;
//   2. every route the manifest drives is a route the app actually serves —
//      a typo in the manifest is a silently missing scan;
//   3. every API handler the app serves is driven, and every handler in the
//      manifest exists;
//   4. the manifest's gated-off list agrees with the app's own gate
//      (`src/lib/deployment/gate.ts`) — the two must not disagree about what
//      is 404 here;
//   5. the manifest is internally consistent — every persona points at a
//      group that exists, and every isolation entry points at a real route.
//
// It is a unit test on purpose: no browser, no database and no running app,
// so it belongs in the fast lane and holds the manifest honest even when the
// live sweep cannot run.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathDisabled } from '../../src/lib/deployment/gate';
import {
  API,
  API_REFUSALS,
  MUTATING,
  GATED_OFF,
  GROUPS,
  ISOLATION,
  PERSONAS,
  pageCount,
  refusalProbeProblems,
} from '../../hosted/tests/user-test/manifest.mjs';

const REPO_ROOT = process.cwd();
const APP_DIR = join(REPO_ROOT, 'src', 'app');

interface AppRoute {
  /** The URL path, with dynamic segments left as they are written. */
  path: string;
  /** True when any segment of the path comes from the database. */
  dynamic: boolean;
  /** True when the route is a route handler rather than a page. */
  handler: boolean;
  /** The HTTP methods a route handler answers, when it is one. */
  methods: string[];
}

/**
 * Every page and every route handler the App Router serves.
 *
 * The walk understands route groups — `(portal)` — which do not appear in the
 * URL, and it records the methods a `route.ts` exports, because a handler
 * that answers only POST is a different surface from one that answers GET.
 */
function appRoutes(dir: string = APP_DIR, prefix = '', dynamic = false): AppRoute[] {
  const found: AppRoute[] = [];

  // The files IN this directory are this directory's route.
  if (existsSync(join(dir, 'page.tsx'))) {
    found.push({ path: prefix || '/', dynamic, handler: false, methods: [] });
  }

  const handlerFile = join(dir, 'route.ts');
  if (existsSync(handlerFile)) {
    const source = readFileSync(handlerFile, 'utf8');
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(source),
    );
    found.push({ path: prefix || '/', dynamic, handler: true, methods });
  }

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

    found.push(...appRoutes(join(dir, entry.name), nextPrefix, nextDynamic));
  }
  return found;
}

const ALL_ROUTES = appRoutes();
const PAGE_ROUTES = ALL_ROUTES.filter((r) => !r.handler);
const HANDLER_ROUTES = ALL_ROUTES.filter((r) => r.handler);

/** Every route the manifest drives, as the manifest writes it. */
const DRIVEN_PAGES = Object.values(GROUPS).flat().map(([path]) => path);
const DRIVEN_API = [...API, ...API_REFUSALS, ...MUTATING].map((entry) => entry.path);

/**
 * Pages this app serves that the sweep deliberately does not drive, each with
 * the reason it cannot be.
 *
 * An entry here is a decision, not a gap. A page that is simply missing from
 * this list fails the completeness check below, which is the point: adding a
 * page to the product means deciding whether it is covered.
 *
 * It is empty today, and that is the honest state: every page this app
 * serves is either driven by the sweep or closed by the deployment gate. The
 * first page that cannot be driven lands here with its reason, and the list
 * stops being a way to hide a gap.
 */
const NOT_DRIVEN: { path: string; reason: string }[] = [];

/** Dynamic segments are placeholders; compare them as such. */
function sameShape(a: string, b: string): boolean {
  const normalise = (p: string) =>
    p
      .split('/')
      .map((s) => (s.startsWith('[') && s.endsWith(']') ? '[id]' : s))
      .join('/');
  return normalise(a) === normalise(b);
}

describe('the user test coverage', () => {
  it('drives every page this app serves, or says why it does not', () => {
    const unexplained = PAGE_ROUTES.filter(
      (route) =>
        !DRIVEN_PAGES.some((driven) => sameShape(driven, route.path)) &&
        !GATED_OFF.some((gated) => sameShape(gated, route.path)) &&
        !NOT_DRIVEN.some((n) => sameShape(n.path, route.path)),
    ).map((route) => route.path);

    expect(
      unexplained,
      'these pages are neither driven nor explained — add them to a route group in ' +
        'hosted/tests/user-test/manifest.mjs, or to NOT_DRIVEN with a reason',
    ).toEqual([]);
  });

  it('drives only pages this app actually serves', () => {
    const missing = DRIVEN_PAGES.filter(
      (driven) => !PAGE_ROUTES.some((route) => sameShape(route.path, driven)),
    );
    expect(missing, 'the manifest drives pages the app does not serve').toEqual([]);
  });

  it('drives every route handler this app serves', () => {
    const unexplained = HANDLER_ROUTES.filter(
      (route) =>
        !DRIVEN_API.some((driven) => sameShape(driven, route.path)) &&
        !GATED_OFF.some((gated) => sameShape(gated, route.path)),
    ).map((route) => route.path);

    expect(
      unexplained,
      'these route handlers are neither driven nor explained — add them to API or ' +
        'API_REFUSALS in hosted/tests/user-test/manifest.mjs',
    ).toEqual([]);
  });

  it('drives only route handlers this app actually serves', () => {
    const missing = DRIVEN_API.filter(
      (driven) => !HANDLER_ROUTES.some((route) => sameShape(route.path, driven)),
    );
    expect(missing, 'the manifest drives handlers the app does not serve').toEqual([]);
  });

  it('explains what every mutating route writes', () => {
    // A route in the mutating tier changes the database. The harness needs to
    // know WHICH change, because that is what the operator is told before the
    // tier is allowed to run, and because a route whose effect nobody can
    // name is a route nobody should let a test drive.
    const unexplained = MUTATING.filter(
      (entry) => typeof entry.changes !== 'string' || entry.changes.trim() === '',
    ).map((entry) => `${entry.method} ${entry.path}`);

    expect(
      unexplained,
      'these routes write but do not say what they write — add a "changes" note ' +
        'to each entry in MUTATING in hosted/tests/user-test/manifest.mjs',
    ).toEqual([]);
  });

  it('never drives a route as both safe and mutating, unless the safe entry refuses before the write', () => {
    // The safe tier is safe because the manifest's specific request to that
    // route is refused before the write. The mutating tier drives the same
    // route with credentials that DO reach the write.
    //
    // A route in both lists is therefore only allowed when its safe entry is
    // a REFUSAL PROBE — the request the route turns away, not the request it
    // accepts. `refusalProbeProblems()` is the rule, and it checks that the
    // entry is marked, that it expects a 4xx, and that its body addresses no
    // row. The rule is in the manifest rather than inline here so that it can
    // be tested against entries that are WRONG — see the negative control
    // below — instead of being trusted.
    const mutatingPaths = new Set(MUTATING.map((entry) => entry.path));
    const problems: string[] = [];
    for (const entry of API) {
      if (!mutatingPaths.has(entry.path)) continue;
      for (const problem of refusalProbeProblems(entry)) {
        problems.push(`${entry.method} ${entry.path}: ${problem}`);
      }
    }

    expect(
      problems,
      'these routes are in both the safe and the mutating list, and their safe ' +
        'entry is not a refusal probe — a route is either driven with a request ' +
        'that cannot write, or it is a writer',
    ).toEqual([]);
  });

  it('rejects a refusal probe that is not one', () => {
    // THE NEGATIVE CONTROL.
    //
    // A gate that has never rejected anything proves nothing, so this checks
    // the rule against entries that are wrong in each of the ways it is
    // supposed to catch.
    const cases: { label: string; entry: Record<string, unknown> }[] = [
      {
        label: 'an entry that is not marked at all',
        entry: { path: '/x', expectStatus: [400], body: {} },
      },
      {
        label: 'a marked entry that expects success',
        entry: { path: '/x', expectStatus: [200], body: {}, refusesBeforeWrite: true },
      },
      {
        label: 'a marked entry that expects nothing',
        entry: { path: '/x', body: {}, refusesBeforeWrite: true },
      },
      {
        label: 'a marked entry that addresses a real row',
        entry: {
          path: '/x',
          expectStatus: [400],
          body: { bankTxId: '[bankTxId]' },
          refusesBeforeWrite: true,
        },
      },
    ];

    for (const { label, entry } of cases) {
      expect(
        refusalProbeProblems(entry),
        `the rule should reject ${label}`,
      ).not.toEqual([]);
    }

    // And the shape it DOES accept, so the rule is not simply rejecting
    // everything: a marked entry that expects a 4xx and addresses no row.
    expect(
      refusalProbeProblems({
        path: '/x',
        expectStatus: [400],
        body: { action: 'match' },
        refusesBeforeWrite: true,
      }),
    ).toEqual([]);
  });

  it('never drives a route this deployment closes', () => {
    for (const path of [...DRIVEN_PAGES, ...DRIVEN_API]) {
      expect(
        GATED_OFF.some((gated) => sameShape(gated, path)),
        `${path} is closed on this deployment and must not be driven as a live route`,
      ).toBe(false);
    }
  });

  it('agrees with the app about which routes this deployment closes', () => {
    // The manifest carries its own copy of the gated paths. This is the check
    // that keeps it honest: the app's own gate is the authority, and
    // `isPathDisabled` is the same function the middleware calls.
    //
    // The profile is set for the duration of the call and restored afterwards,
    // because `deploymentProfile()` reads the environment on every call.
    const saved = process.env.DEPLOYMENT_PROFILE;
    process.env.DEPLOYMENT_PROFILE = 'hosted';
    try {
      for (const route of ALL_ROUTES) {
        if (route.handler) continue;
        expect(
          GATED_OFF.some((gated) => sameShape(gated, route.path)),
          `${route.path} — the manifest's list of closed routes and the app's gate disagree`,
        ).toBe(isPathDisabled(route.path));
      }
    } finally {
      if (saved === undefined) delete process.env.DEPLOYMENT_PROFILE;
      else process.env.DEPLOYMENT_PROFILE = saved;
    }
  });

  it('is internally consistent', () => {
    for (const persona of PERSONAS) {
      for (const group of persona.groups) {
        expect(
          GROUPS[group],
          `the ${persona.key} persona points at a route group "${group}" that does not exist`,
        ).toBeDefined();
      }
      expect(
        persona.home,
        `the ${persona.key} persona has no home console`,
      ).toBeTruthy();
    }

    for (const [personaKey, path] of ISOLATION) {
      expect(
        PERSONAS.some((p) => p.key === personaKey),
        `the isolation list names a persona "${personaKey}" that does not exist`,
      ).toBe(true);
      expect(
        PAGE_ROUTES.some((route) => sameShape(route.path, path)),
        `the isolation list names a route "${path}" that this app does not serve`,
      ).toBe(true);
    }
  });

  it('counts the pages it drives', () => {
    // The count is derived from the same lists the sweep walks, so a number
    // in the handover document cannot disagree with the harness.
    expect(pageCount()).toBe(DRIVEN_PAGES.length);
  });
});
