// tests/unit/hosted-middleware.test.ts
//
// The hosted profile's request middleware. It has to get four things right,
// and each of them was wrong:
//
//   * it must RUN on the hosted profile. It gated on
//     `DEPLOYMENT_PROFILE === 'standalone'` — the desktop product — so on the
//     deployment Brownhill actually runs, the tenant check never happened;
//   * it must not depend on Node built-ins. It decoded the JWT with
//     `Buffer`, which the Edge runtime does not provide, so on the Edge the
//     decode threw, was swallowed, and every bearer request came back 401;
//   * it must read the claim the app actually mints. The app signs `sub`; the
//     middleware looked for `uid`, which nothing in this codebase produces;
//   * it must actually drain. `readDraining()` returned a hard-coded false, so
//     the documented "a restore closes everything except /admin/*" promise was
//     never kept.
//
// The Edge runtime is emulated by breaking exactly the Node global the old
// implementation used — `Buffer.from(…, 'base64')` — rather than by removing
// `Buffer` altogether, which also breaks the test runner's own machinery.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const ORIGINAL_ENV = { ...process.env };

const h = vi.hoisted(() => ({
  /** The PostgREST base URL the middleware should use. '' means "not baked in". */
  postgrestUrl: '',
  /** The value of app_state.app_draining, or null when the row is absent. */
  drainValue: null as string | null,
}));

vi.mock('@/lib/deployment/postgrest', () => ({
  postgrestUrl: () => h.postgrestUrl,
}));

function b64url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A token shaped like the ones the app mints: `sub`, not `uid`. */
function appToken(tenantId: string): string {
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ sub: 'u1', role: 'authenticated', tenant_id: tenantId })),
    'signature-not-verified-by-the-middleware',
  ].join('.');
}

async function loadMiddleware(profile: string) {
  process.env.DEPLOYMENT_PROFILE = profile;
  vi.resetModules();
  return await import('@/middleware');
}

function request(path: string, token?: string): NextRequest {
  const req = new NextRequest(new URL(`https://brownhill.test${path}`));
  if (token) req.headers.set('authorization', `Bearer ${token}`);
  return req;
}

/**
 * Run `fn` with Node's base64 decoding unavailable.
 *
 * Only `Buffer.from(value, 'base64')` is taken away: that is the call the
 * Edge runtime cannot satisfy, and removing the whole global takes the test
 * runner down with it.
 */
async function withoutNodeBase64<T>(fn: () => Promise<T>): Promise<T> {
  const original = Buffer.from;
  const stub = function (this: unknown, ...args: unknown[]) {
    if (args[1] === 'base64') throw new Error('Buffer is not defined in the Edge runtime');
    return (original as unknown as (...a: unknown[]) => unknown).apply(Buffer, args);
  };
  // @ts-expect-error — deliberately breaking the Node global to emulate the Edge runtime.
  Buffer.from = stub;
  try {
    return await fn();
  } finally {
    Buffer.from = original;
  }
}

beforeEach(() => {
  vi.resetModules();
  h.postgrestUrl = '';
  h.drainValue = null;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the hosted middleware', () => {
  it('rejects a tenant-id mismatch with 403', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/t/tenant-b/dashboard', appToken('tenant-a')));
    expect(res.status).toBe(403);
  });

  it('lets a matching tenant through', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/t/tenant-a/dashboard', appToken('tenant-a')));
    expect(res.status).not.toBe(403);
  });

  it('does not run at all on the SaaS profile', async () => {
    const { middleware } = await loadMiddleware('saas');
    const res = await middleware(request('/t/tenant-b/dashboard', appToken('tenant-a')));
    expect(res.status).not.toBe(403);
  });

  it('decodes the token without Node built-ins — the Edge runtime has no Buffer', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await withoutNodeBase64(async () =>
      middleware(request('/t/tenant-b/dashboard', appToken('tenant-a'))),
    );
    expect(res.status).toBe(403);
  });

  it('does not answer 401 to a token that carries the claims the app mints', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/api/v1/accounting/reports/pnl', appToken('tenant-a')));
    expect(res.status).not.toBe(401);
  });

  it('answers 401 to an unreadable token on an API path', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/api/v1/accounting/reports/pnl', 'not-a-jwt'));
    expect(res.status).toBe(401);
  });

  it('does not answer 401 to an unreadable token on a page — that is a stale cookie', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/ops/dashboard', 'not-a-jwt'));
    expect(res.status).not.toBe(401);
  });
});

describe('the path the server needs', () => {
  // A server layout cannot see the URL, so the middleware forwards it as the
  // `x-pathname` request header. The pay-first guard reads it: without the
  // path it cannot tell that the page it is about to redirect TO is one of
  // the pages it must not redirect away from, and it redirects there forever.
  //
  // The header used to be set by `src/lib/supabase/middleware.ts`, which
  // Next.js never loads and whose `updateSession` nothing called — so it was
  // never set at all. The gate for the guard's own half of the story is in
  // `tests/unit/serviceable-guard.test.ts`.

  it('forwards the path to the server on every request it continues', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/ops/drivers'));
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/ops/drivers');
  });

  it('forwards the path on the SaaS profile too, which returns early', async () => {
    const { middleware } = await loadMiddleware('saas');
    const res = await middleware(request('/ops/drivers'));
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/ops/drivers');
  });

  it('forwards the path it resolved, not one the client chose', async () => {
    // A client that could name its own path would walk straight past the
    // pay-first gate by claiming to be on the billing page.
    const { middleware } = await loadMiddleware('hosted');
    const req = request('/ops/drivers');
    req.headers.set('x-pathname', '/ops/billing');
    const res = await middleware(req);
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/ops/drivers');
  });

  it('forwards the path even when the request carries a token it cannot read', async () => {
    // A page request with a stale cookie as its credential. The middleware
    // lets the page's own guard send the visitor to sign in — but it must
    // still forward the path, or the pay-first guard sees no path and
    // declines to redirect, and the tenant walks past it.
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/ops/drivers', 'not-a-jwt'));
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/ops/drivers');
  });

  it('forwards the path when the request carries a token it can read', async () => {
    // The same rule on the last path through the middleware. Every route the
    // middleware continues has to carry the path forward, or the guard's
    // answer depends on whether the request happened to carry a credential.
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/ops/drivers', appToken('tenant-a')));
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/ops/drivers');
  });

  it('is a real gate: a response that forwards no request headers carries no path', () => {
    // The negative control. Before the fix the middleware answered with a
    // plain `NextResponse.next()`, which carries no request headers at all —
    // so the path could not have been forwarded, and the assertions above
    // could not have passed by accident. If `NextResponse.next()` ever grew
    // the header by itself, this control would fail and say so.
    const plain = NextResponse.next();
    expect(plain.headers.get('x-middleware-request-x-pathname')).toBeNull();
  });
});

describe('the routes a system timer calls', () => {  // These are not called by a browser. They are called by a timer on the box,
  // and the bearer they carry is a SHARED SECRET — `CRON_SECRET`,
  // `AUTOMATION_TOKEN` — not a session token. A shared secret is not a JWT.
  //
  // The middleware used to read every `Authorization: Bearer …` as a session
  // token and answer 401 `bad_token` for an API path it could not parse. On
  // Brownhill's own box — the only profile where this middleware runs at all
  // — that meant EVERY scheduled job was refused before its own gate ran: no
  // rent invoice was raised, no agreement completed, no reminder sent, no VAT
  // snapshot taken, and the rent-overdue automation never ran.
  //
  // The jobs existed, the timers fired, the secret was provisioned — and the
  // box did nothing, while every health check that asked "does the route
  // answer 401 without a token?" said yes.
  //
  // The middleware must leave these alone. Each of these routes gates itself,
  // with a constant-time comparison that fails closed.

  it('does not claim the bearer on a cron route', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/api/cron/generate-rent', 'a-shared-secret-not-a-jwt'));
    expect(res.status).not.toBe(401);
  });

  it('does not claim the bearer on an automation route', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/api/automation/rent-overdue', 'a-shared-secret-not-a-jwt'));
    expect(res.status).not.toBe(401);
  });

  it('still claims the bearer on an ordinary API path — the exemption is narrow', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/api/v1/accounting/reports/pnl', 'not-a-jwt'));
    expect(res.status).toBe(401);
  });

  it('still holds the tenant rule on an ordinary API path', async () => {
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/t/tenant-b/dashboard', appToken('tenant-a')));
    expect(res.status).toBe(403);
  });
});

describe('the drain', () => {
  function stubPostgrest(): void {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.includes('/app_state')) {
        const rows = h.drainValue === null ? [] : [{ value: h.drainValue }];
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
  }

  it('answers 503 for a non-admin path while a restore is in progress', async () => {
    h.postgrestUrl = 'http://postgrest.test:3000';
    h.drainValue = '1';
    stubPostgrest();
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/ops/dashboard'));
    expect(res.status).toBe(503);
  });

  it('leaves the operator surfaces open during a restore', async () => {
    h.postgrestUrl = 'http://postgrest.test:3000';
    h.drainValue = '1';
    stubPostgrest();
    const { middleware } = await loadMiddleware('hosted');
    expect((await middleware(request('/admin/restore'))).status).not.toBe(503);
    expect((await middleware(request('/admin/status'))).status).not.toBe(503);
    // The JSON surfaces those pages talk to stay open too: they are how the
    // operator finds out what the drain did, and how a second restore is
    // refused while one is running.
    expect((await middleware(request('/api/admin/restore'))).status).not.toBe(503);
    expect((await middleware(request('/api/admin/status'))).status).not.toBe(503);
  });

  it('serves normally when no restore is in progress', async () => {
    h.postgrestUrl = 'http://postgrest.test:3000';
    h.drainValue = '0';
    stubPostgrest();
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/ops/dashboard'));
    expect(res.status).not.toBe(503);
  });

  it('fails open when PostgREST cannot be reached', async () => {
    h.postgrestUrl = 'http://postgrest.test:3000';
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const { middleware } = await loadMiddleware('hosted');
    const res = await middleware(request('/ops/dashboard'));
    expect(res.status).not.toBe(503);
  });
});
