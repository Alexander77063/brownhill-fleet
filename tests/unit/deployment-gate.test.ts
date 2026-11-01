// tests/unit/deployment-gate.test.ts
//
// Which URLs a deployment profile does not serve.
//
// `src/lib/deployment/gate.ts` decides that. Its own docstring says it
// "runs in middleware so the block is at the edge of the app, before any
// handler and before auth" — and it did not. `isPathDisabled` had no call
// site anywhere in the repository.
//
// That is not a dormant safety net. On the `hosted` profile — the deployment
// Brownhill actually runs — every prefix in the table is disallowed, and the
// routes behind most of them exist:
//
//   /request-access                 a public lead form that says "Elite Fleet
//                                   Management" and "Multi-tenant ·
//                                   White-label · UK-ready", on a box that is
//                                   neither
//   /api/signup-request             the endpoint that form posts to
//   /platform                       the cross-tenant super-admin console
//   /api/platform                   the console's JSON surface
//   /api/billing                    the tenant's subscription TO US
//   /api/cron/subscription-lifecycle the daily job for that subscription
//
// and the sign-in page already promises the block: on a build the customer
// already owns, "a link to /request-access would 404".
//
// So this test is the boundary. It says what the hosted box must NOT serve.
//
// It also pins the one prefix that must NOT be gated, because the page
// behind it is two pages wearing one URL.
//
// `/ops/billing` is "Billing & collections": the subscription panel AND the
// arrears table, the "send payment link to driver" button and the "record
// receipt" form. The subscription half is already hidden on the hosted
// profile — the page renders it only when `payFirst()` is true, and the UK
// market is not pay-first — but the collections half is how Brownhill's
// operator collects rent from their drivers.
//
// The module's own docstring draws exactly this line:
//
//   /api/billing/*   — the tenant's subscription TO US. Gated off-SaaS.
//   /api/payments/*  — the operator collecting rent FROM THEIR DRIVERS.
//
// and the second line is never gated, because gating it stops the customer
// getting paid. A gate that hid the whole `/ops/billing` page would take the
// driver's-rent collection with it, on the one surface Brownhill uses it for.
// The page has to be allowed, and the page hides the subscription half
// itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ORIGINAL_ENV = { ...process.env };

// The drain check reads PostgREST over HTTP. Nothing in this file is about
// the drain, so there is no URL and the read is skipped.
vi.mock('@/lib/deployment/postgrest', () => ({
  postgrestUrl: () => '',
}));

// The negative probe swaps the gate for a broken one, to prove the
// assertions below actually bite. With no probe set, this is the real
// module — see hosted/tests/deployment-gate-negative.sh.
vi.mock('@/lib/deployment/gate', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/deployment/gate')>();
  const probe = process.env.DEPLOYMENT_GATE_PROBE;
  if (probe === 'never-blocks') {
    return { ...original, isPathDisabled: () => false };
  }
  if (probe === 'always-blocks') {
    return { ...original, isPathDisabled: () => true };
  }
  return original;
});

async function loadMiddleware(profile: string) {
  process.env.DEPLOYMENT_PROFILE = profile;
  // The Edge runtime has no runtime environment, so the profile reaches the
  // middleware through the public name next.config inlines at build time.
  // The unit runs both, because the box sets the first and the bundle
  // carries the second.
  process.env.NEXT_PUBLIC_DEPLOYMENT_PROFILE = profile;
  vi.resetModules();
  return await import('@/middleware');
}

function request(path: string, token?: string): NextRequest {
  const req = new NextRequest(new URL(`https://brownhill.test${path}`));
  if (token) req.headers.set('authorization', `Bearer ${token}`);
  return req;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('the hosted profile does not serve the SaaS surfaces', () => {
  const BLOCKED = [
    '/request-access',
    '/api/signup-request',
    '/api/billing',
    '/api/billing/return',
    '/api/billing/webhook/flutterwave',
    '/api/cron/subscription-lifecycle',
    '/platform',
    '/platform/tenants',
    '/platform/subscribers/[tenantId]',
    '/api/platform/copilot',
    '/owner',
    '/owner/login',
  ];

  for (const path of BLOCKED) {
    it(`does not serve ${path}`, async () => {
      const { middleware } = await loadMiddleware('hosted');
      const res = await middleware(request(path));
      expect(res.status).toBe(404);
    });
  }
});

describe('the hosted profile still serves the surfaces Brownhill uses', () => {
  const SERVED = [
    // The operator's own console.
    '/ops/dashboard',
    '/admin/restore',
    // Rent collection: the arrears table, the driver's payment link and the
    // receipt form all live on this one page.
    '/ops/billing',
    // The driver-rent payment path, and the webhooks that tell the tenant
    // they were paid. Gating either stops the customer getting paid.
    '/api/payments/checkout',
    '/api/webhooks/stripe/b1111111-1111-1111-1111-111111111111',
    '/api/webhooks/gocardless/b1111111-1111-1111-1111-111111111111',
    // A path that merely shares a spelling with a gated one. `/ops/billing`
    // is gated on nothing, and `/ops/billingsomething` must not be caught by
    // a prefix match; `/platformer` and `/ownership` likewise.
    '/ops/billingsomething',
    '/platformer',
    '/ownership',
  ];

  for (const path of SERVED) {
    it(`serves ${path}`, async () => {
      const { middleware } = await loadMiddleware('hosted');
      const res = await middleware(request(path));
      expect(res.status).not.toBe(404);
    });
  }
});

describe('the gate is a property of the profile, not of the URL', () => {
  it('serves the platform console on the SaaS profile, which has one', async () => {
    const { middleware } = await loadMiddleware('saas');
    expect((await middleware(request('/platform/tenants'))).status).not.toBe(404);
  });

  it('serves self-serve signup on the SaaS profile', async () => {
    const { middleware } = await loadMiddleware('saas');
    expect((await middleware(request('/request-access'))).status).not.toBe(404);
  });

  it('serves the subscription surfaces on the SaaS profile', async () => {
    const { middleware } = await loadMiddleware('saas');
    expect((await middleware(request('/api/billing'))).status).not.toBe(404);
    expect((await middleware(request('/api/cron/subscription-lifecycle'))).status).not.toBe(404);
  });

  it('does not serve the vehicle-owner portal on the SaaS profile, which has none', async () => {
    // `ownerPortal` is false for `saas`. The gate runs before the
    // `customerOps` early return, so it applies to profiles the rest of the
    // middleware does nothing for.
    const { middleware } = await loadMiddleware('saas');
    expect((await middleware(request('/owner'))).status).toBe(404);
  });

  it('serves the vehicle-owner portal on the managed profile, which has one', async () => {
    const { middleware } = await loadMiddleware('managed');
    expect((await middleware(request('/owner'))).status).not.toBe(404);
  });

  it('does not serve self-serve signup on the managed profile', async () => {
    const { middleware } = await loadMiddleware('managed');
    expect((await middleware(request('/request-access'))).status).toBe(404);
  });

  it('treats the standalone profile like the hosted one', async () => {
    const { middleware } = await loadMiddleware('standalone');
    expect((await middleware(request('/platform'))).status).toBe(404);
    expect((await middleware(request('/ops/billing'))).status).not.toBe(404);
  });
});

describe('the gate runs at the edge, before auth', () => {
  it('answers the gate, not the token, on a gated path', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/platform/tenants', 'not-a-jwt'));
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(401);
  });

  it('still answers 401 to an unreadable token on an ungated API path', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/api/v1/accounting/reports/pnl', 'not-a-jwt'));
    expect(res.status).toBe(401);
  });

  it('tells the operator which path this deployment does not serve', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/platform/tenants'));
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toContain('/platform/tenants');
  });

  it('answers a gated API path with JSON', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/api/signup-request'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
  });
});

describe('the gate table', () => {
  async function gate() {
    return await vi.importActual<typeof import('@/lib/deployment/gate')>(
      '@/lib/deployment/gate',
    );
  }

  it('matches on a path segment boundary, not on a spelling', async () => {
    const { isPathDisabled } = await gate();
    const hosted = {
      id: 'hosted',
      selfServeSignup: false,
      subscriptionBilling: false,
      platformConsole: false,
      singleTenant: true,
      region: 'uk',
      supabaseAuth: false,
      ownerPortal: false,
      customerOps: true,
    } as const;

    expect(isPathDisabled('/api/billing', hosted)).toBe(true);
    expect(isPathDisabled('/api/billing/webhook/flutterwave', hosted)).toBe(true);
    expect(isPathDisabled('/ops/billingsomething', hosted)).toBe(false);
    expect(isPathDisabled('/platformer', hosted)).toBe(false);
    expect(isPathDisabled('/platform/tenants', hosted)).toBe(true);
    expect(isPathDisabled('/platform', hosted)).toBe(true);
  });

  it('does not gate the page that collects rent from the drivers', async () => {
    const { isPathDisabled } = await gate();
    const hosted = {
      id: 'hosted',
      selfServeSignup: false,
      subscriptionBilling: false,
      platformConsole: false,
      singleTenant: true,
      region: 'uk',
      supabaseAuth: false,
      ownerPortal: false,
      customerOps: true,
    } as const;

    // `/ops/billing` serves the tenant's subscription TO US and the rent the
    // tenant collects FROM THEIR DRIVERS. The subscription half is hidden by
    // the page itself, on the region's terms; the rent half is Brownhill's
    // business and is not gated.
    expect(isPathDisabled('/ops/billing', hosted)).toBe(false);
    expect(isPathDisabled('/api/payments/checkout', hosted)).toBe(false);
    expect(isPathDisabled('/api/webhooks/stripe/abc', hosted)).toBe(false);
  });
});
