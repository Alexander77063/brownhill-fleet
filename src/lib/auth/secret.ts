/**
 * The per-install HS256 signing secret.
 *
 * One secret per install, and it is the credential that everything else trusts:
 * PostgREST verifies the session JWT with it, the app signs the session cookie
 * with it, and the service-role token that bypasses RLS is signed with it. If
 * two callers read it from two different places, they can disagree — and a
 * session the app signed is a session PostgREST rejects, which presents as
 * "I type the right password and it bounces me back to the login page".
 *
 * ## Why two environment variable names
 *
 * The hosted deployment writes exactly one secret file,
 * `/etc/brownhill/secrets/jwt.env`, containing `JWT_SHARED_SECRET`. That name
 * is what PostgREST's configuration template substitutes and what the systemd
 * unit loads into the app's environment.
 *
 * The app's own session code, however, read `process.env.LOCAL_JWT_SECRET` —
 * a name that nothing in the deployment has ever set. So on a real Brownhill
 * box `sessionSecret()` threw "LOCAL_JWT_SECRET is not set" on every sign-in
 * and the app was unusable: it could not mint a session, could not sign in,
 * and could not bootstrap its first account.
 *
 * Rather than pick a winner and rename half the deployment, both names are
 * accepted here, in a fixed order, by one resolver. Every caller goes through
 * it, so there is exactly one answer to "what is the secret on this install".
 */

export const JWT_SECRET_ENV_NAMES = ['LOCAL_JWT_SECRET', 'JWT_SHARED_SECRET'] as const;

/**
 * The secret, or null when the install has none.
 *
 * `LOCAL_JWT_SECRET` wins when both are set: it is the more specific name, and
 * an install that sets both is deliberately overriding the shared one.
 */
export function findJwtSecret(): string | null {
  for (const name of JWT_SECRET_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * The secret, or a loud failure.
 *
 * The message names both variables, because an operator who has just read
 * `jwt.env` and seen `JWT_SHARED_SECRET` in it must not be left wondering
 * which name the app wanted — and an operator who has set neither must be
 * told exactly what to set.
 */
export function resolveJwtSecret(): string {
  const secret = findJwtSecret();
  if (secret) return secret;
  throw new Error(
    `Neither ${JWT_SECRET_ENV_NAMES[0]} nor ${JWT_SECRET_ENV_NAMES[1]} is set. ` +
      'It signs the session token PostgREST verifies; the installer generates ' +
      'one per install and writes it to /etc/brownhill/secrets/jwt.env.',
  );
}
