// tests/unit/reset-password-route.test.ts
//
// How the reset-password ROUTE wires itself to the library.
//
// WHY THIS TEST EXISTS
// --------------------
// The library's own behaviour is proved in `password-reset-token.test.ts`.
// This file proves the route hands it the right things, and turns its answer
// into the right answer for the browser.
//
// Two of the defects of 2026-11-04 lived in this wiring, not in the library:
//
//   * the reset wrote NO audit row, even though `docs/product/04-user-flow.md`
//     says every reset is audited;
//   * the redemption answered "ok" and nothing else, so the browser sent the
//     person wherever the LINK had said — which could be half an hour out of
//     date, and on a build with no owner portal, a page that build does not
//     serve.
//
// A library that behaves correctly and a route that hands it the wrong thing
// is still a broken product, so the wiring is pinned here.
//
// The library and the writer are mocked, so this file is about what the route
// PASSES and what it RETURNS, not about what either does with it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RedemptionRequest {
  token: string;
  password: string;
  confirm: string;
}

const captured: { request: RedemptionRequest | null } = { request: null };

/** What the library answers. Replaced by each test. */
let outcome: unknown = { ok: false, reason: 'invalid_token', message: 'not valid' };

/** The rows the route asked the writer to write. */
const auditRows: Array<Record<string, unknown>> = [];

/** The build the route is on. Replaced by each test. */
let ownerPortal = false;

vi.mock('@/lib/deployment/profile', () => ({
  deploymentProfile: () => ({ supabaseAuth: false, ownerPortal }),
}));

vi.mock('@/lib/auth/password-reset-token', () => ({
  completePasswordReset: async (request: RedemptionRequest) => {
    captured.request = request;
    return outcome;
  },
}));

vi.mock('@/lib/auth/password-reset-local-store', () => ({
  localResetTokenStore: async () => ({}),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ mocked: true }),
}));

vi.mock('@/lib/audit', () => ({
  appendAudit: async (_client: unknown, row: Record<string, unknown>) => {
    auditRows.push(row);
  },
}));

const { POST } = await import('@/app/api/auth/local/reset-password/route');

function resetRequest(body: Record<string, unknown> = {}): Request {
  return new Request('https://fleet.example/api/auth/local/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'a-token',
      password: 'a-brand-new-password',
      confirm: 'a-brand-new-password',
      ...body,
    }),
  });
}

/** A successful redemption of an account with the given role and tenant. */
function redemptionOf(role: string, tenantId: string | null) {
  outcome = {
    ok: true,
    userId: '11111111-1111-1111-1111-111111111111',
    account: { role, tenantIds: tenantId ? [tenantId] : [] },
  };
}

describe('the reset-password route', () => {
  beforeEach(() => {
    captured.request = null;
    auditRows.length = 0;
    ownerPortal = false;
    outcome = { ok: false, reason: 'invalid_token', message: 'not valid' };
  });

  it('hands the library the token and the password, and nothing about the build', async () => {
    // The library is deployment-agnostic on purpose: it decides the ACCOUNT,
    // and the route decides the BUILD. A library that knew which build it was
    // on would need a different call on every product, and the drift the
    // review found is exactly what that invites.
    redemptionOf('driver', '22222222-2222-2222-2222-222222222222');

    await POST(resetRequest());

    expect(captured.request).toMatchObject({
      token: 'a-token',
      password: 'a-brand-new-password',
      confirm: 'a-brand-new-password',
    });
    expect(Object.keys(captured.request ?? {}).sort()).toEqual([
      'confirm',
      'password',
      'store',
      'token',
    ]);
  });

  it('sends a driver to the driver sign-in', async () => {
    redemptionOf('driver', '22222222-2222-2222-2222-222222222222');

    const response = await POST(resetRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      audience: 'driver',
      signInUrl: '/driver/login',
    });
  });

  it('sends everybody else to the staff sign-in', async () => {
    redemptionOf('ops', '22222222-2222-2222-2222-222222222222');

    const response = await POST(resetRequest());

    expect(await response.json()).toEqual({
      ok: true,
      audience: 'staff',
      signInUrl: '/login',
    });
  });

  it('sends a vehicle owner to the owner sign-in only where there is one', async () => {
    // On a build with no owner portal, `/owner/login` is a page that build
    // does not serve. The link used to point at it anyway.
    redemptionOf('owner', '22222222-2222-2222-2222-222222222222');

    const withoutPortal = await POST(resetRequest());
    expect(await withoutPortal.json()).toEqual({
      ok: true,
      audience: 'staff',
      signInUrl: '/login',
    });

    ownerPortal = true;
    const withPortal = await POST(resetRequest());
    expect(await withPortal.json()).toEqual({
      ok: true,
      audience: 'owner',
      signInUrl: '/owner/login',
    });
  });

  it('audits the reset, under the tenant the account belongs to', async () => {
    // The user flow says every reset is audited. This one was not.
    redemptionOf('driver', '22222222-2222-2222-2222-222222222222');

    await POST(resetRequest());

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      tenantId: '22222222-2222-2222-2222-222222222222',
      action: 'member.password_reset',
      entityType: 'member',
      entityId: '11111111-1111-1111-1111-111111111111',
      actor: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('audits the reset in every tenant the account belongs to', async () => {
    // One credential opens the account in every one of them, so the reset
    // happened in every one of them.
    outcome = {
      ok: true,
      userId: '11111111-1111-1111-1111-111111111111',
      account: { role: 'driver', tenantIds: ['tenant-a', 'tenant-b'] },
    };

    await POST(resetRequest());

    expect(auditRows.map((r) => r.tenantId)).toEqual(['tenant-a', 'tenant-b']);
  });

  it('audits nothing when the reset was refused', async () => {
    outcome = { ok: false, reason: 'invalid_token', message: 'not valid' };

    const response = await POST(resetRequest());

    expect(response.status).toBe(400);
    expect(auditRows).toHaveLength(0);
  });

  it('answers a failure with the reason and a status that says whose fault it is', async () => {
    outcome = { ok: false, reason: 'failed', message: 'Could not reach the database.' };

    const response = await POST(resetRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Could not reach the database.',
      reason: 'failed',
    });
  });

  it('refuses a request that is not JSON', async () => {
    const response = await POST(
      new Request('https://fleet.example/api/auth/local/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );

    expect(response.status).toBe(400);
    expect(auditRows).toHaveLength(0);
  });
});
