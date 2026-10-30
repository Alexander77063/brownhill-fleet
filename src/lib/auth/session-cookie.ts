/**
 * The session cookie's name and shape.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The cookie name used to live in `local-session.ts`, next to
 * `readSessionClaims()` — which opens a direct connection to Postgres through
 * the `postgres` driver. `src/lib/supabase/server.ts` needs the cookie name
 * (and nothing else from that module), and `supabase/server.ts` is imported by
 * `src/lib/tenancy.ts`, which `src/instrumentation.ts` imports. The chain was:
 *
 *   instrumentation.ts → tenancy.ts → supabase/server.ts → local-session.ts
 *                      → db/local.ts → postgres → net / tls / crypto / stream
 *
 * Next compiles `instrumentation.ts` for the Edge runtime as well as Node, and
 * the Edge runtime has none of those Node built-ins — so the *whole build*
 * failed with "Module not found: Can't resolve 'net'". A constant has no
 * business dragging a database driver into a module graph, so the constant
 * lives somewhere with no imports at all.
 *
 * `local-session.ts` re-exports everything here, so the other importers of
 * these names keep working unchanged.
 */

/** The name of the cookie holding the signed-in session. */
export const SESSION_COOKIE = 'bf_session';

/** Eight hours: a working day, so nobody is signed out mid-shift. */
export const SESSION_SECONDS = 8 * 60 * 60;

/**
 * Thirty days for a vehicle owner. They open a phone app to glance at their
 * car; asking for a new text-message code every morning is the fastest way to
 * lose them. Staff sessions stay at a working day.
 */
export const OWNER_SESSION_SECONDS = 30 * 24 * 60 * 60;

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
