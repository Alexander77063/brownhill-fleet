/**
 * Asking for a password reset link: the half of the reset that faces the
 * outside world.
 *
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------
 * The route is a thin adapter — it turns a request into a call and a call
 * into a response. Everything that decides WHAT HAPPENS lives here, where
 * it can be tested without a framework, a database or a mail provider.
 *
 * THE ONE RULE
 * ------------
 * The answer must not depend on whether the address is on file. Not in the
 * body, not in the status, not in the headers, and — this is the one that
 * was missed — not in how long the answer takes.
 *
 * The timing was the defect of 2026-11-04. The known path did an extra
 * read and an HTTPS round trip to the mail provider; the unknown path did
 * neither. So a known address answered in three hundred milliseconds and
 * an unknown one in twenty, and a stopwatch was an account list.
 *
 * The fix is to take EVERYTHING that depends on the account off the request
 * path. The request path does exactly two things: take the caller's
 * allowance, and answer. The account lookup, the token, the mail and the
 * audit all happen after the response has gone out.
 *
 * WHAT IS LEFT ON THE REQUEST PATH
 * --------------------------------
 *   * the address is trimmed and checked for emptiness;
 *   * the deployment's own origin is read, and a deployment with none is
 *     refused rather than guessed at;
 *   * the caller's allowance is taken, which is a write and therefore also
 *     the answer to "is the database reachable" — a database that is down
 *     says so, and that answer does not depend on the address either.
 *
 * THE ORIGIN
 * ----------
 * The link points at the address the DEPLOYMENT configured, and at nothing
 * else. It used to fall back to the request's own Host header, which means
 * a caller who controls that header controls where the link points — and a
 * link that points at the caller's server hands over the token when it is
 * followed.
 *
 * A deployment with no configured address is refused: no link, the same
 * answer everybody gets, and a loud line in the log. The alternative — a
 * link that does not work — is worse, because the person is told a link is
 * on its way.
 */
import { requestPasswordReset, type ResetAccount, type ResetRequestStore } from './password-reset-request';
import { RESET_REQUEST_MESSAGE } from './password-reset-policy';
import type { ResetThrottleStore } from './password-reset-throttle';

/** Where the operator's record goes. */
export interface ForgotPasswordLog {
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** Everything the handler needs from the outside world. */
export interface ForgotPasswordRequest {
  /** The address the person typed. */
  email: string;
  /**
   * The absolute origin of this deployment, or null when it has none.
   *
   * Never taken from the request. See the note at the top of the file.
   */
  origin: string | null;
  /**
   * The caller's address, from a source the caller cannot forge.
   *
   * See `src/lib/auth/client-ip.ts`.
   */
  clientIp: string | null;
  /** Where the accounts and the tokens live. */
  store: ResetRequestStore;
  /** The allowance. */
  throttle: ResetThrottleStore;
  /** Send the link. */
  deliver: (args: {
    account: ResetAccount;
    token: string;
    expiresAt: Date;
  }) => Promise<{ sent: boolean; reason?: string }>;
  /**
   * Run work AFTER the response has gone out.
   *
   * Injected, because the framework's own `after()` throws outside a
   * request scope, and a unit test is not a request.
   */
  schedule: (work: () => Promise<void>) => void;
  /** "Now" — injected by the tests. */
  now?: () => Date;
  /** Where the operator's record goes. */
  log?: ForgotPasswordLog;
}

/** The answer, in the shape the route turns into a response. */
export interface ForgotPasswordOutcome {
  status: number;
  body: { ok: true; message: string } | { error: string };
}

/**
 * The origin of this deployment, or null when it has not got one.
 *
 * `NEXT_PUBLIC_APP_URL` is the only thing that may decide where a reset
 * link points. The value is checked as well as read: an origin that is not
 * an http or https address is not an address a link can be built on, and a
 * link built on one is either a link that cannot work or a link that runs
 * code when it is followed.
 */
export function configuredResetOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return null;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.host) return null;

  // The ORIGIN, not the whole configured value: a path or a query string in
  // the configuration would otherwise end up in the middle of every link.
  return url.origin;
}

/**
 * Ask for a reset link.
 *
 * The answer is the same for every address, and it comes back before
 * anything that depends on the address has happened.
 */
export async function handleForgotPassword(
  request: ForgotPasswordRequest,
): Promise<ForgotPasswordOutcome> {
  const log = request.log ?? console;
  const now = request.now ?? (() => new Date());
  const email = typeof request.email === 'string' ? request.email.trim() : '';

  // An empty address is not an account. It is refused before anything else
  // happens, and it says so — there is no account to hide here.
  if (!email) {
    return { status: 400, body: { error: 'Enter your email address.' } };
  }

  // No origin, no link. Refused here rather than guessed at, and loudly,
  // because a person who is told a link is on its way and never gets one
  // will ask the office, and the office will not know why.
  if (!request.origin) {
    log.error(
      '[auth] a password reset was asked for, but this deployment has no NEXT_PUBLIC_APP_URL, so no link can be issued',
    );
    return { status: 200, body: { ok: true, message: RESET_REQUEST_MESSAGE } };
  }

  // The allowance is taken BEFORE the account is looked at, and it is taken
  // for EVERY request — the ones that name an address on file and the ones
  // that do not. That is what stops a stranger grinding through addresses:
  // the allowance they spend is the same one a real person's request spends.
  let allowance: Awaited<ReturnType<ResetThrottleStore['takeIpAllowance']>>;
  try {
    allowance = await request.throttle.takeIpAllowance({ ip: request.clientIp, now: now() });
  } catch (err) {
    // The database being unreachable is an operational fault, not a bad
    // address, and saying so saves somebody trying their password ten
    // times.
    log.error('[auth] the password reset throttle could not be read', err);
    return {
      status: 503,
      body: { error: 'We could not start the reset. Please try again in a moment.' },
    };
  }

  if (!allowance.allowed) {
    // Silent, and with nothing in it that says who was asking. A throttle
    // that says "that address has been reset too often" is the same oracle
    // wearing a different hat, and a log line with the address in it is an
    // account list for anybody who can read the log.
    log.warn('[auth] a password reset request was throttled');
    return { status: 200, body: { ok: true, message: RESET_REQUEST_MESSAGE } };
  }

  const requestId = allowance.requestId;

  // Everything that depends on the account happens here, after the response.
  request.schedule(async () => {
    try {
      const result = await requestPasswordReset({
        email,
        store: request.store,
        deliver: request.deliver,
        allowSend: async (account) => {
          // The ACCOUNT's allowance, taken before the mail goes out. An
          // account that has spent it gets no more mail — which is the
          // whole point of the allowance, and the reason it is taken rather
          // than counted afterwards.
          try {
            const claim = await request.throttle.takeAccountAllowance({
              requestId,
              accountId: account.userId,
              now: now(),
            });
            return claim.allowed;
          } catch (err) {
            log.error('[auth] the password reset allowance could not be taken', err);
            return false;
          }
        },
      });

      if (result.outcome !== 'sent' && result.outcome !== 'throttled') {
        // 'sent' and 'throttled' are the ordinary answers. The rest are
        // faults, and the library has already said what they were.
        log.warn(`[auth] the password reset request ended as "${result.outcome}"`);
      }
    } catch (err) {
      log.error('[auth] the password reset request failed', err);
    }
  });

  return { status: 200, body: { ok: true, message: RESET_REQUEST_MESSAGE } };
}
