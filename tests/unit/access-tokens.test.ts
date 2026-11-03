// tests/unit/access-tokens.test.ts
//
// The access + refresh token pair the hosted profile issues.
//
// WHY THIS FILE EXISTS
// --------------------
// The test for this lived in `hosted/tests/auth/test-access-tokens.ts` — a
// file vitest never picked up, because it sat under `hosted/tests/` and
// vitest only collects `tests/**/*.test.ts`. It was written and it had never
// run. This is that test, made live.
//
// WHAT IT GUARDS
// --------------
// The hosted profile does not use a session cookie. A browser needs a Bearer
// token, and it needs a short-lived access token plus a longer-lived refresh
// token, or the user is signed out every five minutes.
//
// The pair has to agree on everything except their lifetime:
//
//   * both carry the same claims — the subject, the role, the tenant and the
//     email. A refresh token that carried a different tenant would move the
//     browser into a tenant it was never signed in to;
//   * the refresh token outlives the access token, by a long way;
//   * both verify against the install's secret, and neither verifies against
//     a different one.
//
// The secret is passed in explicitly here. That is not a shortcut around the
// real code path — it is the `IssueOpts.secret` override the module documents,
// and it keeps the test off the filesystem and out of the environment.

import { describe, expect, it } from 'vitest';
import { issueAccessPair } from '@/lib/auth/access-tokens';
import { verifyJwt } from '@/lib/auth/jwt';

/** 64 hex characters — the shape of the per-install HS256 secret. */
const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

const CLAIMS = {
  sub: 'u1',
  role: 'authenticated' as const,
  tenant_id: 'tenant-A',
  email: 'a@b.test',
};

describe('the access and refresh token pair', () => {
  it('issues two tokens that both verify against the install secret', async () => {
    const { access, refresh } = await issueAccessPair(CLAIMS, { secret: SECRET });

    const a = await verifyJwt(access, SECRET);
    const r = await verifyJwt(refresh, SECRET);

    expect(a.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('gives both tokens the same claims', async () => {
    const { access, refresh } = await issueAccessPair(CLAIMS, { secret: SECRET });

    const a = await verifyJwt(access, SECRET);
    const r = await verifyJwt(refresh, SECRET);
    if (!a.ok || !r.ok) throw new Error('both tokens should verify');

    // The subject is what PostgREST turns into `app.user_id`, and the tenant
    // into `app.tenant_id` — the two claims every RLS policy in the product
    // reads. If the refresh token carried a different tenant, refreshing
    // would move the browser across a tenant boundary.
    expect(a.claims.sub).toBe('u1');
    expect(r.claims.sub).toBe('u1');
    expect(a.claims.tenant_id).toBe('tenant-A');
    expect(r.claims.tenant_id).toBe('tenant-A');
    expect(a.claims.role).toBe('authenticated');
    expect(r.claims.role).toBe('authenticated');
    expect(a.claims.email).toBe('a@b.test');
    expect(r.claims.email).toBe('a@b.test');
  });

  it('makes the refresh token outlive the access token', async () => {
    const { access, refresh } = await issueAccessPair(CLAIMS, { secret: SECRET });

    const a = await verifyJwt(access, SECRET);
    const r = await verifyJwt(refresh, SECRET);
    if (!a.ok || !r.ok) throw new Error('both tokens should verify');

    expect(r.claims.exp).toBeGreaterThan(a.claims.exp);
    // The access token is short (five minutes) and the refresh token is long
    // (thirty days). A refresh token that expired in an hour would sign the
    // user out overnight.
    expect(a.claims.exp - a.claims.iat).toBe(5 * 60);
    expect(r.claims.exp - r.claims.iat).toBe(30 * 24 * 3600);
  });

  it('issues neither token against a different secret', async () => {
    const { access, refresh } = await issueAccessPair(CLAIMS, { secret: SECRET });

    // A token that verified against another install's secret would be a
    // session on somebody else's box.
    expect((await verifyJwt(access, OTHER_SECRET)).ok).toBe(false);
    expect((await verifyJwt(refresh, OTHER_SECRET)).ok).toBe(false);
  });

  it('refuses to issue a pair with no secret at all', async () => {
    // The module reads the install's secret from the environment or from
    // /etc/brownhill/secrets/jwt.env. With neither, it must fail loudly
    // rather than sign with a default — a fixed fallback secret would hand
    // out a working session for any user in any tenant to anybody who simply
    // forgot to set a variable.
    //
    // The empty string is the narrow case of that: the signer refuses it by
    // name, so the failure says what it is rather than producing a token that
    // anybody could forge.
    await expect(issueAccessPair(CLAIMS, { secret: '' })).rejects.toThrow(
      /empty secret/i,
    );
  });
});
