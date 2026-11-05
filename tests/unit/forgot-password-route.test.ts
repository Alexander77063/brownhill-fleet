// tests/unit/forgot-password-route.test.ts
//
// How the forgot-password ROUTE wires itself to the handler.
//
// WHY THIS TEST EXISTS
// --------------------
// The handler's own behaviour is proved in `forgot-password.test.ts`. This
// file proves the route hands it the right things — and the wiring is where
// two of the defects of 2026-11-04 actually lived:
//
//   * the origin in the link was worked out from the request's own Host
//     header, so a caller who controlled that header controlled where the
//     link pointed;
//   * the client address was read from the FIRST element of the forwarded
//     list, which is the one the caller chose.
//
// A handler that behaves correctly and a route that hands it the wrong
// origin is still a broken product, so the wiring is pinned here.
//
// The handler is mocked, so this file is about what the route PASSES, not
// about what the handler does with it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgotPasswordRequest } from '@/lib/auth/forgot-password';
import { RESET_REQUEST_MESSAGE } from '@/lib/auth/password-reset-policy';

const captured: { request: ForgotPasswordRequest | null } = { request: null };
const deferred: Array<() => Promise<void>> = [];
/** The arguments the route handed the email. */
const delivered: Array<Record<string, unknown>> = [];
/** The build the route is on. */
let ownerPortal = false;

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    // The framework's "run this after the response has gone out". The route
    // has to use it, and the only way to know is to watch for it.
    after: (work: () => Promise<void>) => {
      deferred.push(work);
    },
  };
});

vi.mock('@/lib/auth/forgot-password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/forgot-password')>();
  return {
    ...actual,
    handleForgotPassword: async (request: ForgotPasswordRequest) => {
      captured.request = request;
      return { status: 200, body: { ok: true, message: RESET_REQUEST_MESSAGE } };
    },
  };
});

vi.mock('@/lib/deployment/profile', () => ({
  deploymentProfile: () => ({ supabaseAuth: false, ownerPortal }),
}));

vi.mock('@/lib/auth/password-reset-local-store', () => ({
  localResetRequestStore: async () => ({
    findAccountByEmail: async () => null,
    hasPassword: async () => false,
    issueToken: async () => {},
  }),
  localResetTokenStore: async () => ({}),
  localResetThrottleStore: async () => ({
    takeIpAllowance: async () => ({ allowed: true, requestId: 'request-1' }),
    takeAccountAllowance: async () => ({ allowed: true }),
  }),
  makeLocalResetThrottleStore: () => ({
    takeIpAllowance: async () => ({ allowed: true, requestId: 'request-1' }),
    takeAccountAllowance: async () => ({ allowed: true }),
  }),
}));

vi.mock('@/lib/auth/reset-link', () => ({
  deliverResetLink: async (args: Record<string, unknown>) => {
    delivered.push(args);
    return { sent: true };
  },
}));

const { POST } = await import('@/app/api/auth/local/forgot-password/route');

function resetRequest(headers: Record<string, string>): Request {
  return new Request('https://attacker.example/api/auth/local/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'driver@example.com' }),
  });
}

describe('the forgot-password route', () => {
  const originalUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    captured.request = null;
    deferred.length = 0;
    delivered.length = 0;
    ownerPortal = false;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalUrl;
  });

  it('builds the link from the deployment, not from the request', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://fleet.example.com';

    await POST(
      resetRequest({
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      }),
    );

    expect(captured.request).not.toBeNull();
    expect(captured.request!.origin).toBe('https://fleet.example.com');
  });

  it('has no origin at all when the deployment configured none', async () => {
    // Not "the origin the request asked for". A link built from a Host
    // header points at whoever set it.
    delete process.env.NEXT_PUBLIC_APP_URL;

    await POST(
      resetRequest({
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      }),
    );

    expect(captured.request).not.toBeNull();
    expect(captured.request!.origin).toBeNull();
  });

  it('counts the request against the address nginx saw', async () => {
    await POST(
      resetRequest({
        'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9',
        'x-real-ip': '203.0.113.9',
      }),
    );

    expect(captured.request).not.toBeNull();
    expect(captured.request!.clientIp).toBe('203.0.113.9');
  });

  it('defers the account work until the answer has gone out', async () => {
    await POST(resetRequest({}));

    expect(captured.request).not.toBeNull();
    // The route has to hand the handler a way of running work after the
    // response, and that way has to be the framework's.
    expect(typeof captured.request!.schedule).toBe('function');

    let ran = false;
    captured.request!.schedule(async () => {
      ran = true;
    });

    expect(deferred).toHaveLength(1);
    expect(ran).toBe(false);

    await deferred[0]();
    expect(ran).toBe(true);
  });

  it('tells the email which build it is on', async () => {
    // The email cannot work out the door without knowing whether this build
    // HAS a vehicle-owner portal — and an owner pointed at `/owner/login` on
    // a build that does not serve it gets a 404 in the feature built to end
    // dead ends. The route is the only thing that knows the build.
    process.env.NEXT_PUBLIC_APP_URL = 'https://fleet.example.com';
    ownerPortal = true;
    await POST(resetRequest({}));
    expect(captured.request).not.toBeNull();

    await captured.request!.deliver({
      account: {
        userId: '11111111-1111-1111-1111-111111111111',
        email: 'owner@example.test',
        fullName: null,
        tenantId: null,
        role: 'owner',
      },
      token: 'a-token',
      expiresAt: new Date(),
    });

    expect(delivered[0]).toMatchObject({ ownerPortal: true });
  });

  it('says so when the build has NO owner portal', async () => {
    // The negative control. A route that always said "true" would send
    // owners at a page that is not there.
    process.env.NEXT_PUBLIC_APP_URL = 'https://fleet.example.com';
    await POST(resetRequest({}));
    expect(captured.request).not.toBeNull();

    await captured.request!.deliver({
      account: {
        userId: '11111111-1111-1111-1111-111111111111',
        email: 'owner@example.test',
        fullName: null,
        tenantId: null,
        role: 'owner',
      },
      token: 'a-token',
      expiresAt: new Date(),
    });

    expect(delivered[0]).toMatchObject({ ownerPortal: false });
  });

  it('gives the same answer whatever the address turns out to be', async () => {
    const response = await POST(resetRequest({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: RESET_REQUEST_MESSAGE });
  });
});
