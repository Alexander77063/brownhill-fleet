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
    // The hosted box is onboarded through /api/v1/bootstrap, which also
    // closes the bootstrap window, so it must not be redirected to /setup.
    expect(signInCapabilities('hosted').setupPathBuild).toBe(false);
    expect(signInCapabilities('managed-shared').setupPathBuild).toBe(false);
    expect(signInCapabilities('saas').setupPathBuild).toBe(false);
  });

  it('never offers a method the build cannot honour', () => {
    // Every mode the page can offer must be one the deployment supports:
    // a code needs either vehicle owners or Supabase's phone OTP, and an
    // email link needs Supabase Auth.
    for (const profile of ['saas', 'standalone', 'hosted', 'managed', 'managed-shared']) {
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
