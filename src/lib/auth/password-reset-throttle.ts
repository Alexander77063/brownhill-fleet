/**
 * The throttle behind the self-service password reset.
 *
 * WHY THE THROTTLE EXISTS
 * -----------------------
 * The forgot-password endpoint takes an address and does something with it.
 * Two things about it are worth limiting:
 *
 *   * how often one caller may ask, so one address cannot be flooded with
 *     reset mail, and so a stranger cannot grind through a list of addresses
 *     at full speed; and
 *   * how often one ACCOUNT may be sent a link, so a hundred concurrent
 *     requests for one inbox do not become a hundred emails.
 *
 * WHAT WAS WRONG
 * --------------
 * The security review of 2026-11-04 found three defects, and they were all
 * in the ORDER of things:
 *
 *   1. The counter was incremented AFTER the mail had gone out. The whole
 *      email round trip happens between the check and the increment, so a
 *      hundred concurrent requests all passed the check and a hundred mails
 *      went to the same inbox.
 *
 *   2. The counter was only incremented for addresses that were ON FILE. A
 *      stranger guessing addresses was never counted at all, so the limit
 *      that was supposed to slow them down did not apply to them. The
 *      counter counted the requests that had already succeeded, which is the
 *      opposite of what a limiter is for.
 *
 *   3. The address the limit was counted against came from the first
 *      element of the forwarded list, which is the element the CALLER
 *      chose. See `src/lib/auth/client-ip.ts`.
 *
 * THE RULE NOW
 * ------------
 * An allowance is TAKEN, not counted after the fact. Taking it is one
 * transaction — the check and the record land together, under a lock — so
 * concurrent requests cannot all pass one limit. See
 * `makeLocalResetThrottleStore` in `password-reset-local-store.ts`.
 *
 * TWO ALLOWANCES
 * --------------
 * Per ADDRESS and per CALLER, and they answer different questions:
 *
 *   * the per-caller allowance bounds how many requests one source can
 *     make, whatever address it names. Every request counts, whether or not
 *     the address is on file — that is what stops the guessing.
 *
 *   * the per-account allowance bounds how many links one inbox receives.
 *     It is only reached for an account that exists, so a stranger's
 *     guesses never spend anybody's allowance.
 *
 * NO ADDRESS IS STORED
 * --------------------
 * The table holds the CALLER's address and the ACCOUNT it turned out to
 * belong to — never the address that was typed. A reset request says "the
 * person at this address asked for a reset"; that is a fact about an
 * ACCOUNT, and an account has an id. Keeping the typed address as well
 * would have meant keeping a list of addresses that people typed, including
 * the ones that belong to nobody, which is both personal data and a list of
 * who is on file.
 */

/**
 * How many links one account may be sent in fifteen minutes.
 *
 * Three is enough for a person who has genuinely forgotten their password —
 * they ask, they do not find the mail, they ask again — and few enough that
 * a flood is not a flood.
 */
export const MAX_RESET_REQUESTS_PER_ACCOUNT_15M = 3;

/**
 * How many reset requests one caller may make in an hour.
 *
 * This is the allowance that bounds the guessing, because EVERY request
 * counts against it: the ones that name an address on file and the ones
 * that do not.
 */
export const MAX_RESET_REQUESTS_PER_IP_1H = 10;

/** The window the per-account allowance is counted over. */
export const RESET_ACCOUNT_WINDOW_MINUTES = 15;

/** The window the per-caller allowance is counted over. */
export const RESET_IP_WINDOW_MINUTES = 60;

/**
 * How long a request is kept.
 *
 * Twice the longest window, so a request can never be pruned while it is
 * still counting towards an allowance — and so the table does not grow
 * without bound on a box that is asked for a reset every week for years.
 */
export const RESET_REQUEST_RETENTION_MINUTES = 120;

/**
 * The store the throttle reads and writes through.
 *
 * The two operations are ATOMIC: the check and the record are one
 * transaction, and concurrent requests for the same allowance are
 * serialised. An implementation that checks and then writes in two steps
 * has the defect the review found, whatever the numbers say.
 */
export interface ResetThrottleStore {
  /**
   * Take one unit of this caller's allowance, if it has one left.
   *
   * Every request counts, whether or not the address it names is on file.
   *
   * The request is recorded either way: the record is what the per-account
   * allowance is later counted against, and it is what the table's size is
   * bounded by.
   */
  takeIpAllowance(args: {
    /** The caller's address, or null when there is none worth counting. */
    ip: string | null;
    /** "Now" — injected by the tests. */
    now: Date;
  }): Promise<ResetIpAllowance>;

  /**
   * Take one unit of this account's allowance, if it has one left, and
   * attach the request to the account it turned out to belong to.
   *
   * Called only for an account that exists. A stranger's guesses never
   * reach it, so they never spend a real person's allowance.
   */
  takeAccountAllowance(args: {
    /** The request this allowance is for. */
    requestId: string;
    /** The account the request turned out to belong to. */
    accountId: string;
    /** "Now" — injected by the tests. */
    now: Date;
  }): Promise<{ allowed: boolean }>;
}

/** What came of taking a caller's allowance. */
export type ResetIpAllowance =
  | { allowed: true; requestId: string }
  | { allowed: false; requestId: null };

/**
 * The window an allowance is counted over, as a moment in the past.
 *
 * One place, so the number of minutes and the arithmetic that uses it
 * cannot drift apart.
 */
export function windowStart(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60 * 1000);
}
