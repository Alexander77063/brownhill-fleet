/**
 * The signed-in session for the standalone build.
 *
 * One cookie holds the HS256 JWT. It is the same token PostgREST verifies, so
 * there is exactly one credential in play rather than a session cookie that
 * has to be kept in step with a separate database token — two things that can
 * disagree, and eventually will.
 *
 * The cookie is `httpOnly`, so page scripts cannot read the token even though
 * the browser sends it. `SameSite=Lax` blocks cross-site POSTs while leaving
 * ordinary navigation working. It is deliberately NOT `Secure`: a standalone
 * install is served over plain HTTP on `127.0.0.1`, and a `Secure` cookie would
 * simply never be stored, presenting as "sign-in does nothing".
 */
import { cookies } from 'next/headers';
import { signJwt, verifyJwt, type JwtClaims } from './jwt';
import { resolveJwtSecret } from './secret';
import { localDb } from '@/lib/db/local';
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  OWNER_SESSION_SECONDS,
  sessionCookieOptions,
} from './session-cookie';

// Re-exported so the importers of these names keep working. They live in
// `./session-cookie` — a module with no imports — because this one opens a
// Postgres connection, and `supabase/server.ts` needs only the cookie name.
// See the note at the top of `./session-cookie`.
export { SESSION_COOKIE, SESSION_SECONDS, OWNER_SESSION_SECONDS, sessionCookieOptions };

/**
 * The signing secret, shared with PostgREST.
 *
 * Absent under a customer-facing profile is fatal, on the same reasoning as the
 * storage signing key: this token is what PostgREST trusts to decide which
 * tenant's rows a request may see.
 *
 * The resolver lives in `./secret` because three other callers need the same
 * answer and the deployment only ever sets one of the two names it accepts —
 * see the note there.
 */
export function sessionSecret(): string {
  return resolveJwtSecret();
}

export async function issueSessionToken(
  user: { id: string; email?: string | null },
  tenantId: string | null,
  seconds: number = SESSION_SECONDS,
): Promise<string> {
  return signJwt(
    {
      sub: user.id,
      // PostgREST switches into this role; RLS then does the rest.
      role: 'authenticated',
      ...(user.email ? { email: user.email } : {}),
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    sessionSecret(),
    seconds,
  );
}

/** Verify a raw cookie value, returning its claims or null. */
export async function readSessionToken(token: string | undefined): Promise<JwtClaims | null> {
  if (!token) return null;
  const res = await verifyJwt(token, sessionSecret());
  return res.ok ? res.claims : null;
}

export interface SessionClaims {
  /** The signed-in user's id — the JWT's `sub`. */
  userId: string;
  /** The tenant the session is acting in, if the token names one. */
  tenantId: string | null;
  /**
   * The IAM role the user holds in that tenant: `owner`, `tenant_admin`, `md`,
   * `director_exec`, `director_nonexec`, `ops`, `accounts`, `driver` or
   * `investor`. This is `tenant_memberships.role` — the tenant's view of the
   * person — and NOT `profiles.role`, which is the portal the account signs
   * into. The two vocabularies overlap by accident, not by design.
   */
  role: string;
}

/**
 * Who is signed in, and what are they allowed to be.
 *
 * The token says *who*; it does not say *what role they hold*, because the
 * role is tenant data that changes — somebody is promoted to `owner`, somebody
 * is disabled — and a token minted eight hours ago would keep asserting the
 * old answer. So the role is read from the database on every request.
 *
 * ## Why the direct connection is safe here
 *
 * This query runs on the owner connection, where RLS does not apply, so it
 * breaks the project's rule that every RLS-bypassing query must filter by
 * tenant in application code. It cannot: it is the query that decides the
 * tenant. What makes it safe is where `user_id` comes from — it is never
 * client-supplied. It is the `sub` of a JWT this server just verified with
 * the shared secret, so the row it can reach is the signed-in person's own
 * membership and no one else's. The same reasoning as `primaryTenantId`.
 */
export async function readSessionClaims(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const claims = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!claims?.sub) return null;

  const tenantId = claims.tenant_id ?? null;
  const db = await localDb();
  const rows = (await db`
    select role::text as role
    from tenant_memberships
    where user_id = ${claims.sub}
      and status = 'active'
      and (${tenantId}::uuid is null or tenant_id = ${tenantId}::uuid)
    order by created_at
    limit 1
  `) as Array<{ role: string }>;

  const role = rows[0]?.role;
  if (!role) return null;
  return { userId: claims.sub, tenantId, role };
}
