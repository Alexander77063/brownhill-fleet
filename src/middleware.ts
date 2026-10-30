// src/middleware.ts
// Per-request tenant-id enforcement + the app_draining 503 for non-`/admin/*` paths.
// RLS already enforces the tenant rule identically; this is belt + braces over a
// token that names the wrong tenant.
//
// ## Where this runs, and what that decides
//
// The middleware runs in the Edge runtime. Two things follow from that, and
// both were bugs for a long time:
//
//   * There is no runtime environment. Next gives the Edge sandbox only its
//     own build-id keys, so `process.env.DEPLOYMENT_PROFILE` is `undefined`
//     there. The profile therefore comes from `NEXT_PUBLIC_DEPLOYMENT_PROFILE`,
//     which next.config.ts inlines into the bundle at build time, and
//     `deploymentProfile()` falls back to it. The old code compared
//     `DEPLOYMENT_PROFILE === 'standalone'` — the *desktop* product — so on
//     the hosted deployment Brownhill actually runs, this middleware did
//     nothing at all.
//
//   * There is no database connection. The `postgres` driver cannot run on the
//     Edge, so the drain flag cannot be read with `localDb()` the way the
//     design notes assumed. It is read over HTTP from PostgREST instead — the
//     same PostgREST the rest of the app talks to, through a policy that
//     exposes exactly one row (migration 0080).
//
// The URL is baked at build time by next.config.ts's `compiler.defineServer`,
// because an Edge bundle has no way to learn it at runtime.

import { NextRequest, NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { postgrestUrl } from '@/lib/deployment/postgrest';

/** How long a drain reading is trusted for. */
const DRAIN_TTL_MS = 500;

/** How long to wait for PostgREST before deciding it is not draining. */
const DRAIN_TIMEOUT_MS = 1000;

let drainCache: { checkedAt: number; draining: boolean } | null = null;

/**
 * Is a restore in progress?
 *
 * The flag lives in `app_state.app_draining` — the same row `/admin/restore`
 * writes — so it survives a restart and is shared by every process on the box.
 * It is read at most twice a second, so the cost in steady state is one
 * request per half second regardless of how many requests arrive.
 *
 * A failed read means "not draining". The alternative — treating an
 * unreachable PostgREST as a restore in progress — would close the whole
 * application because a dependency was briefly down, which is a far worse
 * failure than the one being guarded against.
 */
async function readDraining(): Promise<boolean> {
  const now = Date.now();
  if (drainCache && now - drainCache.checkedAt < DRAIN_TTL_MS) return drainCache.draining;

  const base = postgrestUrl();
  let draining = false;

  if (base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRAIN_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/app_state?key=eq.app_draining&select=value`, {
        headers: { apikey: 'anon' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (res.ok) {
        const rows: unknown = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          draining = (rows[0] as { value?: unknown })?.value === '1';
        }
      }
    } catch {
      draining = false;
    } finally {
      clearTimeout(timer);
    }
  }

  drainCache = { checkedAt: now, draining };
  return draining;
}

/**
 * The claims this middleware needs out of a bearer token.
 *
 * `sub` is the claim the app actually mints — `issueSessionToken` and
 * `issueAccessPair` both sign `sub`, and `uid` is not produced anywhere in
 * this codebase. The old middleware looked for `uid`, so every token the app
 * issued failed to parse and came back 401. `uid` is still accepted as a
 * fallback for a token minted elsewhere.
 */
interface TokenClaims {
  sub: string;
  tenantId: string | null;
  role: string | null;
}

/**
 * Decode one base64url segment of a JWT.
 *
 * `atob` rather than `Buffer`: the Edge runtime has no `Buffer` of its own,
 * and the previous implementation's `Buffer.from(...)` threw, was swallowed by
 * the `catch`, and turned every bearer request into a 401.
 */
function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function parseJwt(token: string): TokenClaims | null {
  try {
    const payload = JSON.parse(decodeBase64Url(token.split('.')[1] ?? '')) as Record<string, unknown>;
    const sub =
      typeof payload.sub === 'string' && payload.sub
        ? payload.sub
        : typeof payload.uid === 'string' && payload.uid
          ? payload.uid
          : null;
    if (!sub) return null;
    return {
      sub,
      tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
      role: typeof payload.role === 'string' ? payload.role : null,
    };
  } catch {
    return null;
  }
}

/**
 * Is this path one the operator keeps open during a restore?
 *
 * The operator's own tools stay open: `/admin/*` are the pages, and
 * `/api/admin/*` are the JSON surfaces those pages talk to. A drain closes
 * the business application so it cannot serve from a database that is being
 * replaced underneath it — it must not close the tools the operator needs in
 * order to see what the drain did, or to start the next restore.
 */
function isAdminPath(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

export async function middleware(req: NextRequest) {
  // Only a box the customer operates has the operator surfaces this middleware
  // protects. On every other profile it does nothing at all.
  if (!deploymentProfile().customerOps) return NextResponse.next();

  const pathname = req.nextUrl.pathname;

  if (await readDraining()) {
    if (!isAdminPath(pathname)) {
      return NextResponse.json(
        { error: 'restoring', retry_after_seconds: 5 },
        { status: 503 },
      );
    }
  }

  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return NextResponse.next(); // not yet authed; downstream 401s
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return NextResponse.next();

  const claims = parseJwt(token);
  if (!claims) {
    // A token we cannot read is fatal where the token IS the credential. On a
    // page it is nearly always a stale cookie, and the page's own guard
    // sends the visitor to sign in — answering 401 there would replace a
    // sign-in page with a bare JSON error.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'bad_token' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // `/t/<tenant>/…` names the tenant in the path. A token for another tenant
  // must not be used against it.
  const m = pathname.match(/^\/t\/([^/]+)/);
  if (m && decodeURIComponent(m[1]) !== claims.tenantId) {
    return NextResponse.json({ error: 'tenant_mismatch' }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything the browser can ask for, except Next's own assets and the few
   * files served straight off disk.
   *
   * The matcher used to be `['/t/:path*', '/api/v1/:path*']`. `/t/` is not a
   * route in this codebase at all, so the only paths it really covered were
   * the API — and the documented promise that a drain closes "everything
   * except /admin/*" was not kept. The matcher now covers the application.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
