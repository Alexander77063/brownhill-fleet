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
import { signJwt, verifyJwt, type JwtClaims } from './jwt';

export const SESSION_COOKIE = 'bf_session';

/** Eight hours: a working day, so nobody is signed out mid-shift. */
export const SESSION_SECONDS = 8 * 60 * 60;

/**
 * Thirty days for a vehicle owner. They open a phone app to glance at their
 * car; asking for a new text-message code every morning is the fastest way to
 * lose them. Staff sessions stay at a working day.
 */
export const OWNER_SESSION_SECONDS = 30 * 24 * 60 * 60;

/**
 * The signing secret, shared with PostgREST.
 *
 * Absent under a customer-facing profile is fatal, on the same reasoning as the
 * storage signing key: this token is what PostgREST trusts to decide which
 * tenant's rows a request may see.
 */
export function sessionSecret(): string {
  const secret = process.env.LOCAL_JWT_SECRET;
  if (!secret) {
    throw new Error(
      'LOCAL_JWT_SECRET is not set. It signs the session token PostgREST verifies; ' +
        'the installer generates one per install.',
    );
  }
  return secret;
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

/** Cookie attributes for `Set-Cookie`, shared by the sign-in and sign-out paths. */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Not `secure`: loopback HTTP would refuse to store it.
    secure: false,
    path: '/',
    maxAge,
  };
}
