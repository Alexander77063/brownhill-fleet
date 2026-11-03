/**
 * Which sign-in methods a build may offer.
 *
 * The sign-in page chose its methods by testing the profile id against the
 * literal string `'standalone'`. The deployment Brownhill actually runs is
 * `hosted` — the same product on a server instead of a desktop — so it fell
 * through to the "has owners" branch and offered:
 *
 *     [ Phone code ] [ Password ]     default: Phone code
 *
 * on a build that has no vehicle owners at all. `ownerPortal` is false there,
 * so there is nobody for the phone-code path to sign in: `resolveOwnerSignIn`
 * refuses staff outright ("Staff accounts sign in with a password") and
 * refuses unknown numbers on a dedicated instance. The operator's first screen
 * on the live box asked for a mobile number they do not have, for an account
 * that cannot be created that way.
 *
 * The rule this pins: the set of sign-in methods follows whether the build has
 * vehicle owners, not what the profile is called.
 */

import { describe, expect, it } from 'vitest';
import { signInCapabilities } from '@/lib/deployment/signin-modes';
import { isPathDisabled } from '@/lib/deployment/gate';

const PROFILES = ['saas', 'standalone', 'hosted', 'managed', 'managed-shared'] as const;

describe('signInCapabilities', () => {
  it('offers password only on the hosted deployment Brownhill runs', () => {
    const caps = signInCapabilities('hosted');
    expect(caps.modes).toEqual(['password']);
    expect(caps.defaultMode).toBe('password');
    expect(caps.ownerBuild).toBe(false);
  });

  it('offers password only on the desktop build', () => {
    const caps = signInCapabilities('standalone');
    expect(caps.modes).toEqual(['password']);
    expect(caps.defaultMode).toBe('password');
  });

  it('offers a code first where vehicle owners sign in with a code', () => {
    for (const profile of ['managed', 'managed-shared']) {
      const caps = signInCapabilities(profile);
      expect(caps.modes).toEqual(['phone', 'password']);
      expect(caps.defaultMode).toBe('phone');
      expect(caps.ownerBuild).toBe(true);
    }
  });

  it('leaves the SaaS with its three methods, email first', () => {
    const caps = signInCapabilities('saas');
    expect(caps.modes).toEqual(['email', 'password', 'phone']);
    expect(caps.defaultMode).toBe('email');
    expect(caps.ownerBuild).toBe(false);
  });

  it('treats an unknown or missing profile as the SaaS, like the brand does', () => {
    expect(signInCapabilities(undefined).modes).toEqual(['email', 'password', 'phone']);
    expect(signInCapabilities('').modes).toEqual(['email', 'password', 'phone']);
    expect(signInCapabilities('nonsense').modes).toEqual(['email', 'password', 'phone']);
  });

  it('knows which builds are onboarded through the browser setup page', () => {
    // The desktop product and the dedicated Nigerian instance create their
    // first account at /setup, and the sign-in page sends the operator there
    // when the database is empty. The Nigeria runbook says so in §A.4 — and
    // the sign-in page only did it for `standalone`, so the documented flow
    // was broken on `managed` too.
    expect(signInCapabilities('standalone').setupPathBuild).toBe(true);
    expect(signInCapabilities('managed').setupPathBuild).toBe(true);
    // The hosted box is onboarded through /api/v1/bootstrap, so it must not
    // be redirected to /setup.
    expect(signInCapabilities('hosted').setupPathBuild).toBe(false);
    expect(signInCapabilities('managed-shared').setupPathBuild).toBe(false);
    expect(signInCapabilities('saas').setupPathBuild).toBe(false);
  });

  it('never offers a method the build cannot honour', () => {
    // Every mode the page can offer must be one the deployment supports:
    // a code needs either vehicle owners or Supabase's phone OTP, and an
    // email link needs Supabase Auth.
    for (const profile of PROFILES) {
      const caps = signInCapabilities(profile);
      expect(caps.modes.length).toBeGreaterThan(0);
      expect(caps.modes).toContain(caps.defaultMode);
      if (caps.modes.includes('phone')) {
        expect(caps.ownerBuild || caps.supabaseAuth).toBe(true);
      }
      if (caps.modes.includes('email')) {
        expect(caps.supabaseAuth).toBe(true);
      }
    }
  });
});

/**
 * The OTHER sign-in pages on this build.
 *
 * `/login` is the staff door. It used to be the ONLY sign-in page anyone
 * could reach from it, which made the relationship one-way:
 *
 *   /driver/login  →  "← back to sign-in options"  →  /login
 *
 * but nothing on `/login` pointed back at the driver form. A driver who
 * followed a stale link, or who typed the wrong URL, or who was sent to the
 * wrong door, arrived at a staff form that does not know they are a driver,
 * signed in with it, and was then bounced by `ROLE_HOME` — with no way back
 * to the page they were supposed to be on.
 *
 * The rule this pins: `/login` offers the other sign-in pages THIS build
 * serves, and no others. Not "the other sign-in pages" — the owner portal is
 * gated off on the Brownhill box, and a link to `/owner/login` there is a
 * door that opens onto a 404.
 */
describe('the other sign-in pages this build serves', () => {
  it('offers the driver portal on every build', () => {
    // Drivers exist on every profile — the Brownhill box rents vehicles to
    // drivers, the Nigerian instances manage driver agreements, and the SaaS
    // does both. `/driver` is not in the gate table, so it is served
    // everywhere.
    for (const profile of PROFILES) {
      const hrefs = signInCapabilities(profile).portals.map((p) => p.href);
      expect(hrefs, `profile ${profile}`).toContain('/driver/login');
    }
  });

  it('offers the owner portal only where the owner portal exists', () => {
    const hrefsFor = (profile: string) => signInCapabilities(profile).portals.map((p) => p.href);

    // `ownerPortal` is false for saas, standalone and hosted: `/owner` is
    // closed on those builds, so the owner sign-in page is not offered.
    expect(hrefsFor('saas')).not.toContain('/owner/login');
    expect(hrefsFor('standalone')).not.toContain('/owner/login');
    expect(hrefsFor('hosted')).not.toContain('/owner/login');

    // The Nigerian builds do have vehicle owners, so they do.
    expect(hrefsFor('managed')).toContain('/owner/login');
    expect(hrefsFor('managed-shared')).toContain('/owner/login');
  });

  it('never offers a sign-in page this build does not serve', () => {
    // The app's own gate is the authority on what exists. Every portal the
    // sign-in page offers must be one the gate lets through — otherwise the
    // page is advertising a 404 as a way in.
    const original = process.env.DEPLOYMENT_PROFILE;
    try {
      for (const profile of PROFILES) {
        process.env.DEPLOYMENT_PROFILE = profile;
        for (const portal of signInCapabilities(profile).portals) {
          expect(
            isPathDisabled(portal.href),
            `${profile} offers ${portal.href}, which this build does not serve`,
          ).toBe(false);
        }
      }
    } finally {
      process.env.DEPLOYMENT_PROFILE = original;
    }
  });

  it('has teeth: the owner sign-in page really is closed on the Brownhill box', () => {
    // The check above is only worth anything if the gate would actually catch
    // a wrong link. It does: `/owner` is gated off on `hosted`, so were the
    // rule to offer it there, the check above would fail rather than pass
    // quietly.
    const original = process.env.DEPLOYMENT_PROFILE;
    try {
      process.env.DEPLOYMENT_PROFILE = 'hosted';
      expect(isPathDisabled('/owner/login')).toBe(true);
      expect(isPathDisabled('/driver/login')).toBe(false);
    } finally {
      process.env.DEPLOYMENT_PROFILE = original;
    }
  });

  it('labels every portal it offers', () => {
    // An unlabelled link is a link nobody can recognise.
    for (const profile of PROFILES) {
      for (const portal of signInCapabilities(profile).portals) {
        expect(portal.label.length).toBeGreaterThan(0);
        expect(portal.href.startsWith('/')).toBe(true);
      }
    }
  });
});
