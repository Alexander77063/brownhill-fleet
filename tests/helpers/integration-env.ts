/**
 * The environment an integration test needs, and the rule for when its
 * absence is allowed.
 *
 * An integration test that needs a real postgres AND a running application
 * cannot run without them. It can only skip — and a skip looks exactly like a
 * pass in a build log. That is how a job goes green while the check it claims
 * to have run never ran: this repository has been bitten by it twice, once
 * with the hosted smoke test and once with the accessibility scan.
 *
 * So there are two modes, and the job chooses:
 *
 *   * REQUIRE_INTEGRATION unset — the test SKIPS, out loud. This is the unit
 *     job, which has no database and no application and does not pretend to.
 *   * REQUIRE_INTEGRATION=1 — the test FAILS if the environment is missing.
 *     The hosted-smoke job sets it, so that job cannot go green without the
 *     integration tests having actually run.
 *
 * The environment is read on every call. Every integration test asks for it
 * once, at module scope, and holds the answer — so a file cannot change its
 * mind halfway through about whether it is running — and reading it per call
 * is what lets a test prove what the helper does. See
 * tests/unit/integration-env.test.ts, which is the negative control for the
 * throw below: take the throw away and that file fails.
 *
 * NOT EVERY FILE NEEDS THE APPLICATION
 * ------------------------------------
 * Some integration tests talk straight to postgres — through `localDb()`,
 * which is the direct connection — and never touch the service client. Those
 * files ask for `{ app: false }`, and are then held to DATABASE_URL alone.
 *
 * That is not a loophole. It is the difference between a gate that says
 * "this check needs a database" and one that says "this check needs a
 * database AND a running server". A gate that demands more than the check
 * uses is a gate that will be silenced — somebody will set the extra variable
 * to make it quiet, or drop the check to make it pass. Requiring only what is
 * actually needed keeps the skip loud where it matters and quiet where it
 * does not.
 */

/** Everything an integration test can need. */
export interface IntegrationEnv {
  /** The postgres the application and the test both talk to. */
  DATABASE_URL: string;
  /**
   * The running application.
   *
   * Not optional decoration: the service client calls the application's OWN
   * origin, which rewrites `/rest/v1/*` to PostgREST. Without the origin the
   * client has nowhere to send its requests, so every write the test makes
   * fails with a connection error that says nothing about what was being
   * tested.
   */
  APP_ORIGIN: string;
}

/** What a test that talks straight to postgres needs. */
export interface DatabaseEnv {
  DATABASE_URL: string;
}

/**
 * The integration environment, or null when it is legitimately absent.
 *
 * Throws when the job has said the environment is required and it is not
 * there — a missing dependency is a failure, not a skip.
 */
export function integrationEnv(): IntegrationEnv | null;
export function integrationEnv(options: { app: false }): DatabaseEnv | null;
export function integrationEnv(options: { app: true }): IntegrationEnv | null;
export function integrationEnv(
  options: { app?: boolean } = {},
): IntegrationEnv | DatabaseEnv | null {
  const needsApp = options.app !== false;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const appOrigin = process.env.APP_ORIGIN?.trim();

  const missing: string[] = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (needsApp && !appOrigin) missing.push('APP_ORIGIN');

  if (missing.length === 0) {
    if (needsApp) return { DATABASE_URL: databaseUrl!, APP_ORIGIN: appOrigin! };
    return { DATABASE_URL: databaseUrl! };
  }

  if (process.env.REQUIRE_INTEGRATION === '1') {
    throw new Error(
      `REQUIRE_INTEGRATION=1 was set, but ${missing.join(' and ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing. The integration tests cannot run without them, and a test that ` +
        'did not run is not a test that passed.',
    );
  }

  const remedy = needsApp
    ? 'They need a real postgres with the migrations applied AND the application\n' +
      '            running, because the service client talks to it over HTTP. Set\n' +
      '            REQUIRE_INTEGRATION=1 to make a missing environment a failure instead.'
    : 'They need a real postgres with the migrations applied. Set\n' +
      '            REQUIRE_INTEGRATION=1 to make a missing environment a failure instead.';

  console.warn(
    `[integration] ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set — the ` +
      'integration tests in this file are being SKIPPED.\n' +
      '            ' +
      remedy,
  );
  return null;
}
