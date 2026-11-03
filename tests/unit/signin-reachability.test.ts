/**
 * A sign-in page must be reachable WITHOUT a session.
 *
 * The defect this pins:
 *
 *   `/driver/login` was a file at `src/app/driver/login/page.tsx`, so it sat
 *   inside `src/app/driver/layout.tsx` — and that layout calls
 *   `requireRole(['driver'])`, which redirects to `/login` when there is no
 *   session. A signed-out driver was therefore bounced off the sign-in page
 *   before it could render. The same was true of `/owner/login` under the
 *   owner layout.
 *
 *   That made the URL the operations app hands drivers — `inviteDriverAction`
 *   returns `${base}/driver/login` — a dead end: the driver follows the link
 *   and lands on the generic sign-in page instead of their own. It also made
 *   the "Forgot password?" links on those pages unfixable in place: any
 *   recovery route under the same layout is behind the same session gate.
 *
 * The rule, stated so it can be checked mechanically:
 *
 *   A page whose route ends in `/login` must not have a session-gated layout
 *   anywhere above it.
 *
 * "Above it" means the directory chain, including route groups — a layout in
 * `src/app/driver/(portal)/layout.tsx` still applies to everything inside
 * `(portal)`, and the `(portal)` segment itself does not appear in the URL.
 * The gated-portal pages therefore live in a route group and the sign-in page
 * lives outside it, which is what keeps `/driver/login` public while
 * `/driver/charges` stays behind the guard.
 *
 * The second half of the rule is that a public sign-in page must not link to a
 * gated route. That is the original bug in its other form: `/driver/login`
 * linked "Forgot password?" to `/driver/profile`, and `/owner/login` linked it
 * to `/owner/settings/security` — both behind their own layout's guard, so a
 * locked-out user was redirected straight back to the form they came from.
 *
 * The final tests are the ones that stop this gate from being satisfied by
 * deleting the guards instead of fixing the structure: the portals must still
 * be gated, and the URL the invite hands out must be a real public page.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signInCapabilities } from '@/lib/deployment/signin-modes';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..', '..', 'src', 'app');
const REPO_DIR = join(HERE, '..', '..');

/** Every directory under `src/app`, deepest last. */
function allDirectories(root: string, found: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    found.push(full);
    allDirectories(full, found);
  }
  return found;
}

/**
 * The URL a directory maps to.
 *
 * Route groups — `(portal)` — do not appear in the URL, so they are dropped
 * here. That is exactly why the layout has to live in one for this fix to
 * work, and why a naive prefix check cannot decide whether a route is gated:
 * `/driver` and `/driver/login` share a prefix but not a layout.
 */
function routeOf(directory: string): string {
  const parts = relative(APP_DIR, directory)
    .split(sep)
    .filter((part) => part && !part.startsWith('('));
  return '/' + parts.join('/');
}

/** The layout source in `directory`, or null when it has none. */
function layoutSource(directory: string): string | null {
  const file = join(directory, 'layout.tsx');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Does this layout demand a session? `requireRole` is how a layout asks for one. */
function isSessionGated(source: string): boolean {
  return /requireRole\s*\(/.test(source);
}

/** The directories from `src/app` down to `directory`, inclusive. */
function ancestorsOf(directory: string): string[] {
  const chain: string[] = [];
  let current = APP_DIR;
  chain.push(current);
  const relativeParts = relative(APP_DIR, directory).split(sep).filter(Boolean);
  let walked = APP_DIR;
  for (const part of relativeParts) {
    walked = join(walked, part);
    chain.push(walked);
  }
  return chain;
}

/** Every page route in the app, mapped to the directory that serves it. */
const PAGES = new Map<string, string>();
for (const directory of allDirectories(APP_DIR)) {
  if (!existsSync(join(directory, 'page.tsx'))) continue;
  PAGES.set(routeOf(directory), directory);
}

/** The routes whose page sits under at least one session-gated layout. */
const GATED_ROUTES = new Set<string>();
for (const [route, directory] of PAGES) {
  const gated = ancestorsOf(directory).some((ancestor) => {
    const source = layoutSource(ancestor);
    return source !== null && isSessionGated(source);
  });
  if (gated) GATED_ROUTES.add(route);
}

/** The sign-in pages: any route whose last segment is `login`. */
const SIGNIN_ROUTES = [...PAGES.keys()].filter((route) => route.split('/').pop() === 'login');

/** Every href in a page's source, as written. */
function hrefsIn(source: string): string[] {
  const found: string[] = [];
  const pattern = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    found.push(match[1] ?? match[2] ?? '');
  }
  return found;
}

describe('sign-in pages', () => {
  it('finds the sign-in pages it is checking', () => {
    // If this is empty the gate below would pass by inspecting nothing.
    expect(SIGNIN_ROUTES.length).toBeGreaterThan(0);
    expect(SIGNIN_ROUTES).toContain('/driver/login');
  });

  it('are not nested under a session-gated layout', () => {
    const offences: string[] = [];
    for (const route of SIGNIN_ROUTES) {
      const directory = PAGES.get(route)!;
      for (const ancestor of ancestorsOf(directory)) {
        const source = layoutSource(ancestor);
        if (source !== null && isSessionGated(source)) {
          offences.push(
            `${route} sits under ${relative(REPO_DIR, ancestor).split(sep).join('/')}, which requires a session`,
          );
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('do not link to a route that needs a session', () => {
    const offences: string[] = [];
    for (const route of SIGNIN_ROUTES) {
      const source = readFileSync(join(PAGES.get(route)!, 'page.tsx'), 'utf8');
      for (const href of hrefsIn(source)) {
        if (!href.startsWith('/')) continue;
        const target = href.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
        if (PAGES.has(target) && GATED_ROUTES.has(target)) {
          offences.push(`${route} links to ${target}, which requires a session`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe('the portals are still gated', () => {
  it('guards the driver portal', () => {
    // The gate above would be satisfiable by removing every guard, so the
    // guarded set is asserted to be non-empty and to contain the portal.
    expect(GATED_ROUTES.has('/driver')).toBe(true);
    expect(GATED_ROUTES.has('/driver/charges')).toBe(true);
  });

  it('guards the operations and admin portals', () => {
    expect(GATED_ROUTES.has('/ops')).toBe(true);
    expect(GATED_ROUTES.has('/ops/drivers')).toBe(true);
    expect(GATED_ROUTES.has('/admin')).toBe(true);
  });

  it('leaves the generic sign-in page public', () => {
    expect(PAGES.has('/login')).toBe(true);
    expect(GATED_ROUTES.has('/login')).toBe(false);
  });
});

describe('the URL the driver invite hands out', () => {
  const action = readFileSync(join(REPO_DIR, 'src', 'lib', 'actions', 'driver-invite.ts'), 'utf8');

  it('is a page that exists', () => {
    expect(action).toMatch(/\/driver\/login/);
    expect(PAGES.has('/driver/login')).toBe(true);
  });

  it('is a page a signed-out driver can actually open', () => {
    expect(GATED_ROUTES.has('/driver/login')).toBe(false);
  });
});

/**
 * `/login` must offer the OTHER sign-in pages this build serves.
 *
 * The defect: the driver and owner forms both link back to `/login` ("← back
 * to sign-in options"), but `/login` linked to neither. The relationship was
 * one-way. A driver who was sent the wrong URL, followed a stale bookmark, or
 * simply guessed `/login` arrived at the staff form, signed in there, was
 * bounced by the role check, and had no way back to the page meant for them.
 *
 * The rule has two halves, and both matter:
 *
 *   1. `/login` offers the other sign-in pages this build SERVES.
 *   2. `/login` offers no others. The vehicle-owner portal is gated off on
 *      the hosted deployment Brownhill runs, so a link to `/owner/login`
 *      there is a door that opens onto a 404.
 *
 * Which portals exist is decided by `signInCapabilities`, not by the page —
 * the page asks the rule and renders what it is told. That is what keeps the
 * two halves from drifting apart: adding a portal to the rule adds it to
 * every build that serves it and to no build that does not.
 */
describe('the sign-in page offers the other portals', () => {
  const PROFILES = ['saas', 'standalone', 'hosted', 'managed', 'managed-shared'] as const;
  const LOGIN_ROUTE = '/login';
  const loginSource = readFileSync(join(PAGES.get(LOGIN_ROUTE)!, 'page.tsx'), 'utf8');

  it('finds the sign-in page it is checking', () => {
    expect(PAGES.has(LOGIN_ROUTE)).toBe(true);
  });

  it('renders the portals the build serves', () => {
    // The rule can be perfect while the page stays dead, so the page has to
    // actually read it.
    expect(loginSource).toContain('CAPS.portals');
    expect(loginSource).toMatch(/CAPS\.portals\.map\(/);
  });

  it('asks the rule rather than repeating it', () => {
    // The hrefs are not written into the page. If they were, the page and the
    // rule would be two copies of the same fact, free to disagree — which is
    // how the owner link would end up on a build that has no owner portal.
    expect(loginSource).not.toContain('/driver/login');
    expect(loginSource).not.toContain('/owner/login');
  });

  it('never offers a portal that is not a page, or that needs a session', () => {
    const offences: string[] = [];
    for (const profile of PROFILES) {
      for (const portal of signInCapabilities(profile).portals) {
        const target = portal.href.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
        if (!PAGES.has(target)) {
          offences.push(`${profile} offers ${target}, which is not a page`);
        } else if (GATED_ROUTES.has(target)) {
          offences.push(`${profile} offers ${target}, which requires a session`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('gives every portal a way back to the sign-in page', () => {
    // The relationship has to work both ways, or offering the portals here
    // would be sending someone down a one-way street.
    const offences: string[] = [];
    for (const profile of PROFILES) {
      for (const portal of signInCapabilities(profile).portals) {
        const directory = PAGES.get(portal.href);
        if (!directory) continue; // reported by the test above
        const source = readFileSync(join(directory, 'page.tsx'), 'utf8');
        if (!hrefsIn(source).includes(LOGIN_ROUTE)) {
          offences.push(`${portal.href} has no link back to ${LOGIN_ROUTE}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('has teeth: without the rule, the page would have offered nothing', () => {
    // A control for the two tests above. The page did once carry no link to
    // either console, and the relationship was one-way; the checks are worth
    // something only because that was true.
    expect(hrefsIn(loginSource)).not.toContain('/driver/login');
    expect(hrefsIn(loginSource)).not.toContain('/owner/login');
    // And the way back was already there — that half was never broken.
    const driverSource = readFileSync(join(PAGES.get('/driver/login')!, 'page.tsx'), 'utf8');
    expect(hrefsIn(driverSource)).toContain(LOGIN_ROUTE);
  });
});
