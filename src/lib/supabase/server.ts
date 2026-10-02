import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { deploymentProfile } from '@/lib/deployment/profile';
import { signJwt } from '@/lib/auth/jwt';
import { SESSION_COOKIE } from '@/lib/auth/local-session';
import type { Database } from './database.types';

/**
 * The subject a trusted server call acts as.
 *
 * The all-zero UUID rather than a real user: an audit row attributing a cron
 * job to a named employee would be a lie, and one that is hard to unpick later.
 */
const SERVICE_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Placeholder for supabase-js's required `key` argument in the standalone build.
 *
 * PostgREST does not read the `apikey` header at all — it authorises from the
 * bearer token — but supabase-js refuses to construct a client with an empty
 * key, so a signed-out visitor would crash the login page.
 */
export const ANON_KEY = 'anon';

/**
 * Where the data API lives, and what authorises a call to it.
 *
 * Hosted: Supabase, authorised by the session cookie Supabase Auth set.
 * Standalone: the app's own origin, which rewrites `/rest/v1/*` to the bundled
 * PostgREST (see next.config.ts), authorised by the HS256 JWT in our session
 * cookie. PostgREST verifies that token and `auth.pre_request()` turns its
 * claims into the `app.user_id` GUC the RLS policies read.
 *
 * Both paths produce the same client type, so the 370 `.from()` calls and 25
 * `.rpc()` calls elsewhere in the app are identical under either product.
 */
function isStandalone(): boolean {
  return !deploymentProfile().supabaseAuth;
}

function localBaseUrl(): string {
  // The server calls itself, so the rewrite applies and PostgREST is never
  // addressed directly — one place decides where it lives.
  return process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** Supabase client for Server Components, Server Actions and Route Handlers. */
export async function createClient() {
  const cookieStore = await cookies();

  if (isStandalone()) {
    // The user's own token. Absent (signed out) means an anonymous client,
    // which RLS correctly shows nothing — it must not fall back to anything
    // more privileged.
    const token = cookieStore.get(SESSION_COOKIE)?.value ?? '';
    // The key argument must be non-empty — supabase-js throws "Your project's
    // URL and Key are required" otherwise, which for a signed-out visitor means
    // the login page itself 500s. PostgREST ignores the apikey header entirely;
    // authorisation comes from the bearer token, and its absence correctly
    // leaves the caller anonymous.
    return createServerClient<Database>(localBaseUrl(), token || ANON_KEY, {
      cookies: { getAll: () => [], setAll: () => {} },
      global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    });
  }

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options as never));
          } catch {
            // called from a Server Component — middleware refreshes the session instead
          }
        },
      },
    },
  );
}

/**
 * Service-role client for trusted server contexts (webhooks, cron). Bypasses RLS.
 *
 * Standalone mints a `service_role` token locally rather than reading one from
 * the environment. The invariant is unchanged from the hosted product: every
 * RLS-bypassing query must still filter by `tenant_id` in application code.
 */
export function createServiceClient() {
  if (isStandalone()) {
    const secret = process.env.LOCAL_JWT_SECRET;
    if (!secret) {
      throw new Error('LOCAL_JWT_SECRET is not set; trusted server calls cannot be authorised.');
    }
    // Signing is async (Web Crypto), but every caller of createServiceClient is
    // synchronous. supabase-js accepts a function for the Authorization header
    // and awaits it, so the token is minted per request instead — which also
    // means a long-lived client never carries a stale one.
    const token = () =>
      signJwt(
        { sub: SERVICE_PRINCIPAL_ID, role: 'service_role' },
        secret,
        300,
      );
    return createServerClient<Database>(localBaseUrl(), 'service_role', {
      cookies: { getAll: () => [], setAll: () => {} },
      global: {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${await token()}`);
          return fetch(input, { ...init, headers });
        },
      },
    });
  }

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } },
  );
}
