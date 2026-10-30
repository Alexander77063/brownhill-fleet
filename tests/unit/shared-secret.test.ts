// tests/unit/shared-secret.test.ts
//
// One HS256 secret per install, and the app must be able to find it wherever
// the deployment puts it.
//
// The hosted deployment writes exactly one secret — `JWT_SHARED_SECRET` — into
// /etc/brownhill/secrets/jwt.env, which PostgREST verifies with and which the
// systemd unit loads into the Next app's environment. The app's own session
// code, however, read `process.env.LOCAL_JWT_SECRET` — a name that nothing
// in the deployment ever set. So on the live box every sign-in attempt threw
// "LOCAL_JWT_SECRET is not set" and the app was unusable.
//
// The rule these tests pin: the app accepts either name, and every caller of
// "the secret" goes through the same resolver, so the session cookie, the
// service token and the bootstrap access pair can never be signed with
// different values.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.LOCAL_JWT_SECRET;
  delete process.env.JWT_SHARED_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('the per-install signing secret', () => {
  it('is read from LOCAL_JWT_SECRET when that is set', async () => {
    process.env.LOCAL_JWT_SECRET = 'from-local';
    const { sessionSecret } = await import('@/lib/auth/local-session');
    expect(sessionSecret()).toBe('from-local');
  });

  it('falls back to JWT_SHARED_SECRET — the name the hosted deployment sets', async () => {
    process.env.JWT_SHARED_SECRET = 'from-shared';
    const { sessionSecret } = await import('@/lib/auth/local-session');
    expect(sessionSecret()).toBe('from-shared');
  });

  it('prefers LOCAL_JWT_SECRET when both are set', async () => {
    process.env.LOCAL_JWT_SECRET = 'from-local';
    process.env.JWT_SHARED_SECRET = 'from-shared';
    const { sessionSecret } = await import('@/lib/auth/local-session');
    expect(sessionSecret()).toBe('from-local');
  });

  it('throws a message naming BOTH names when neither is set', async () => {
    const { sessionSecret } = await import('@/lib/auth/local-session');
    expect(() => sessionSecret()).toThrow(/LOCAL_JWT_SECRET/);
    expect(() => sessionSecret()).toThrow(/JWT_SHARED_SECRET/);
  });
});

describe('the bootstrap access pair', () => {
  it('is signed with the secret from the environment', async () => {
    process.env.JWT_SHARED_SECRET = 'env-secret';
    const { issueAccessPair } = await import('@/lib/auth/access-tokens');
    const { verifyJwt } = await import('@/lib/auth/jwt');

    const { access, refresh } = await issueAccessPair({
      sub: '11111111-1111-1111-1111-111111111111',
      role: 'authenticated',
      tenant_id: '22222222-2222-2222-2222-222222222222',
      email: 'owner@brownhill.test',
    });

    const checked = await verifyJwt(access, 'env-secret');
    expect(checked.ok).toBe(true);
    const refreshed = await verifyJwt(refresh, 'env-secret');
    expect(refreshed.ok).toBe(true);
  });

  it('is signed with the secret from LOCAL_JWT_SECRET too', async () => {
    process.env.LOCAL_JWT_SECRET = 'local-secret';
    const { issueAccessPair } = await import('@/lib/auth/access-tokens');
    const { verifyJwt } = await import('@/lib/auth/jwt');

    const { access } = await issueAccessPair({
      sub: '11111111-1111-1111-1111-111111111111',
      role: 'authenticated',
      tenant_id: '22222222-2222-2222-2222-222222222222',
      email: 'owner@brownhill.test',
    });

    expect((await verifyJwt(access, 'local-secret')).ok).toBe(true);
  });
});
