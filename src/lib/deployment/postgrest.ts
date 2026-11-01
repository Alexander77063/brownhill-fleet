/**
 * Where PostgREST listens.
 *
 * The address is baked into the bundle at build time, by next.config.ts's
 * `compiler.defineServer`, and there is deliberately no runtime fallback: the
 * Edge runtime has no runtime environment to read one from, so a value read
 * at runtime would simply be `undefined` there — which is how the middleware
 * ended up unable to reach the database at all.
 *
 * The build-time source of truth is the same `POSTGREST_URL` environment
 * variable the `/rest/v1` rewrite uses, so the two cannot drift apart.
 */

/** Substituted into the server bundle at build time. */
declare const __POSTGREST_URL__: string;

/**
 * The PostgREST base URL, or an empty string when it was not baked in.
 *
 * `typeof` guards the reference: in a unit test the constant does not exist,
 * and a bare reference would throw a ReferenceError instead of evaluating.
 */
export function postgrestUrl(): string {
  return typeof __POSTGREST_URL__ === 'string' ? __POSTGREST_URL__ : '';
}
