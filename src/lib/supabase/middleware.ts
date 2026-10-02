import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { readSessionToken, SESSION_COOKIE } from '@/lib/auth/local-session';
import { ROLE_HOME } from '@/components/shell/nav';
import type { Database } from './database.types';
import type { UserRole } from './database.types';

/**
 * Paths that bypass the session check.
 *
 * `/api/cron` is here because Vercel Cron calls carry `Authorization: Bearer
 * ${CRON_SECRET}` and NO session cookie — without the exemption every scheduled job
 * is redirected to /login and silently never runs. Those endpoints are not
 * unprotected: `isCronAuthorized` (src/lib/cron.ts) gates each one and fails closed
 * in production. Exported so the exemption can be asserted in tests.
 */
export const PUBLIC_PREFIXES = ['/login', '/request-access', '/terms', '/privacy', '/acceptable-use', '/dpa', '/accessibility', '/auth', '/offline', '/_next', '/icons', '/favicon', '/manifest', '/icon.svg', '/sw.js', '/sign', '/api/sign', '/api/signup-request', '/api/billing', '/api/gps', '/api/branding/logo', '/api/cron', '/api/auth/local', '/api/storage/local', '/rest/v1', '/setup',
  // NG-2: the public pay page. Trailing slash on purpose — the bare startsWith
  // clause below would otherwise also open any future /pay… route.
  '/pay/'];

/**
 * Refreshes the Supabase session cookie and enforces role-based routing:
 *   - unauthenticated → /login
 *   - authenticated user hitting a portal not matching their role → their home
 */
export async function updateSession(request: NextRequest) {
  // Server layouts cannot see the URL; the subscription gate (NG-2) needs it to
  // allow-list the billing and help pages. Forwarded as a request header, copied
  // fresh each time so cookie changes made below are not lost.
  const nextWithPathname = () => {
    const h = new Headers(request.headers);
    h.set('x-pathname', request.nextUrl.pathname);
    return NextResponse.next({ request: { headers: h } });
  };
  let response = nextWithPathname();

  // "standalone" here means local auth: every build without Supabase Auth.
  const standalone = !deploymentProfile().supabaseAuth;

  // In a standalone install there is no Supabase session cookie to refresh —
  // identity is our own HS256 token, verified here with the same secret
  // PostgREST uses. Built with that token so the profile lookup below is made
  // as the user, and RLS still applies to it.
  const token = standalone ? request.cookies.get(SESSION_COOKIE)?.value : undefined;
  const localClaims = standalone ? await readSessionToken(token) : null;

  const supabase = standalone
    ? // The key must be non-empty: supabase-js throws "Your project's URL and
      // Key are required" on an empty one, and since middleware runs on every
      // request that turned the login page itself into a 500 for anyone not
      // already signed in. PostgREST ignores the apikey header; the bearer
      // token is what authorises, and its absence correctly means anonymous.
      createServerClient<Database>(request.nextUrl.origin, token || 'anon', {
        cookies: { getAll: () => [], setAll: () => {} },
        global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      })
    : createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = nextWithPathname();
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options as never));
        },
      },
    },
  );

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p));

  const user = standalone
    ? localClaims && { id: localClaims.sub }
    : (await supabase.auth.getUser()).data.user;

  if (!user) {
    if (isPublic || path === '/') return response;
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Resolve role
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  const role = (profile?.role ?? 'driver') as UserRole;
  const home = ROLE_HOME[role];

  // Authenticated users shouldn't sit on /login or /
  if (path === '/login' || path === '/') {
    const url = request.nextUrl.clone();
    url.pathname = home;
    return NextResponse.redirect(url);
  }

  // Portal isolation: keep users inside their own portal
  const portals: Array<[string, UserRole]> = [
    ['/ops', 'ops'],
    ['/driver', 'driver'],
    ['/investor', 'investor'],
    ['/owner', 'owner'],
  ];
  for (const [prefix, allowed] of portals) {
    if (path.startsWith(prefix) && role !== allowed) {
      const url = request.nextUrl.clone();
      url.pathname = home;
      return NextResponse.redirect(url);
    }
  }

  return response;
}
