/**
 * The token half of the self-service password reset.
 *
 * WHY THIS EXISTS
 * ---------------
 * A driver who forgot their password had one route back in: phone the office,
 * and the office logged in to the operations app and pressed "Reset password"
 * on their record. That is a recovery path for the OFFICE, not for the
 * person. On a box that is not staffed around the clock, a driver who cannot
 * get in cannot start a shift, and the complaint lands on the office before
 * it lands on the software.
 *
 * The schema already had the columns for this — `auth.local_credentials`
 * carries `reset_token_hash` and `reset_expires_at`, with a comment saying
 * "the app checks expiry before accepting" — and NOTHING used them. The
 * columns were the plan; the code never arrived.
 *
 * THE TOKEN
 * ---------
 * The token is 32 random bytes from the system CSPRNG. Only its SHA-256 is
 * stored. That matters more than it looks: this product's database sits on a
 * box the customer can read, and a stored token would be a stored credential.
 * A stored HASH is not — an attacker who reads the table gets a value they
 * cannot present.
 *
 * The token is good for half an hour, and for one use. Redemption clears it
 * in the same write that sets the password, so a link that has been used
 * stops working even if the browser keeps the page open.
 *
 * "for one use" is a property of the WRITE, not of the read. The write is
 * conditional on the token being redeemed still being the live token for
 * that account, so a second redemption of the same link matches no row and
 * changes nothing. Clearing the token without naming it is not that: it
 * spends whatever token the row happens to hold, and leaves a window in
 * which the same link works twice. See `redeem` below, and the store's
 * `WHERE` clause, which is where the property actually lives.
 *
 * THE TWO RULES THAT MATTER MOST
 * ------------------------------
 *   * A failure to READ is a refusal, never a write. The read is what
 *     decides whose account is being opened, so a store that cannot answer
 *     must abort rather than guess.
 *   * An unknown token and an expired token are refused for the SAME reason.
 *     Different reasons would make the page an oracle for "which tokens
 *     exist", and there is no reason to leak that.
 *
 * The store is injected, so every branch runs without a database — the same
 * shape `src/lib/auth/password-reset.ts` uses for the operator's reset.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  MIN_RESET_PASSWORD_LENGTH,
  RESET_TOKEN_TTL_SECONDS,
} from './password-reset-policy';

/**
 * The two numbers the browser needs as well, re-exported from the module that
 * is safe to ship to it.
 *
 * They are DEFINED in `password-reset-policy.ts`, because this file imports
 * `node:crypto` and a client component must not pull that into the browser
 * bundle. Re-exported here so the server still has one obvious place to
 * import them from, and so the tests that already import them from here keep
 * working.
 */
export { MIN_RESET_PASSWORD_LENGTH, RESET_TOKEN_TTL_SECONDS };

/**
 * A reset token: 32 random bytes, base64url.
 *
 * 32 bytes is 256 bits. It is not a guessable number and it does not need
 * to be short-lived for its own sake — the half-hour window below is what
 * bounds it.
 */
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The hash of a token — the only form that is ever stored.
 *
 * SHA-256 of the token, hex. It is a plain hash rather than a password hash
 * on purpose: the token is 256 bits of CSPRNG output, so there is nothing
 * to brute-force, and the lookup has to be an indexed equality match.
 */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Thrown by a store when a redemption was refused because the token is no
 * longer the live token for that account.
 *
 * This is not a fault — it is the answer, and it is the answer to "this link
 * has already been used". A store that cannot spend the token must throw
 * THIS, so the library can tell it apart from a database that broke, and can
 * give the person the same refusal an unknown token gets. The page must not
 * be able to tell "this link was used" from "this link never existed": the
 * first says a reset happened, and that is somebody's account history.
 */
export class ResetTokenSpentError extends Error {
  constructor(message = 'That reset link is not valid. Ask for a new one.') {
    super(message);
    this.name = 'ResetTokenSpentError';
  }
}

/**
 * The account as it is at the moment of redemption.
 *
 * The link in the email names a door, and the link can be half an hour old
 * when it is used. If the role changed in that time, the door in the link is
 * the wrong one — so the role is read HERE, at the redemption, rather than
 * taken from the link.
 *
 * The tenant list is here for the same reason: the audit row is filed under
 * the account's tenant, and a reset that cannot be filed is a reset the
 * trail never saw.
 */
export interface ResetAccountNow {
  /** The role on file right now. Empty when the account has no profile row. */
  role: string;
  /** The tenants the account belongs to right now, by id. */
  tenantIds: string[];
}

/**
 * Everything the redemption needs from the outside world.
 *
 * The implementation owns `auth.local_credentials`; a test owns a fake.
 */
export interface ResetTokenStore {
  /**
   * Record a token hash and its expiry for this account, replacing any
   * token that was there before.
   *
   * One live token per account is deliberate: a second request must stop the
   * first link from working, or a link that was already forwarded keeps
   * working for the whole of its window.
   */
  issue(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /**
   * The account a token belongs to, and when it stops working.
   *
   * Null when the token is unknown — which includes a token that has already
   * been used, because redemption clears it.
   *
   * This is a READ, and a read cannot promise that the token is still live
   * by the time it is spent: it may be spent by a redemption that is in
   * flight at this moment. That is why the single-use property lives in the
   * WRITE's condition and not here.
   */
  findByTokenHash(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  /**
   * Is this the password the account already holds?
   *
   * A reset to the password already in use proves nothing and leaves the
   * account exactly as exposed as it was, so it is refused. The comparison
   * lives behind the store because that is where the stored hash is.
   */
  passwordMatches(userId: string, password: string): Promise<boolean>;
  /**
   * Set the new password and spend the token, in one step.
   *
   * The token HASH is an argument, and it belongs in the write's condition.
   * That is the whole of the single-use property: the row is updated only if
   * the token being redeemed is STILL the token on the account, so two
   * redemptions of the same link cannot both land — the second matches no
   * row, and the first one's password is the one that stands.
   *
   * A store that ignores the hash and clears whatever token it finds has not
   * implemented single use. It has implemented "the token is cleared", which
   * is a different thing, and it leaves the window open.
   *
   * If this throws `ResetTokenSpentError`, the token was not live and
   * nothing was changed. If it throws anything else, nothing was changed
   * either — the password and the spent token land together, or neither
   * does — so a transient database error does not lock the person out for
   * good.
   */
  redeem(userId: string, tokenHash: string, password: string): Promise<void>;
  /**
   * The account as it is NOW — its role, and the tenants it belongs to.
   *
   * This is read at the REDEMPTION, not when the link was sent, because the
   * link can be half an hour old and the role can have changed in that time.
   *
   * It is a READ, and it is read BEFORE the write: a read that cannot answer
   * is a refusal, never a write. The role is what decides the door the
   * person is sent to, and the tenant is what the audit row is filed under —
   * so a reset must not go ahead on a guess.
   */
  currentAccount(userId: string): Promise<ResetAccountNow>;
}

/** Why a redemption was refused. */
export type ResetCompleteReason =
  | 'invalid_request'
  | 'invalid_token'
  | 'password_too_short'
  | 'mismatch'
  | 'must_differ'
  | 'failed';

export type ResetCompleteOutcome =
  | {
      ok: true;
      /** The account the password was changed on. */
      userId: string;
      /** The account as it was at the moment of the redemption. */
      account: ResetAccountNow;
    }
  | { ok: false; reason: ResetCompleteReason; message: string };

/**
 * Redeem a reset token: set a new password.
 *
 * The order of the checks matters. The request is validated first (a token
 * and a password are both needed); then the token is read, and a read that
 * FAILS is a refusal rather than an empty answer; then the window is
 * checked; then the new password is checked against the one already in use;
 * and only then is anything written.
 *
 * The failure messages are written for the person reading them, and never
 * contain the password or the token.
 */
export async function completePasswordReset(args: {
  /** The token from the link. */
  token: string;
  /** The new password. */
  password: string;
  /** The new password again, when the caller has it. */
  confirm?: string;
  /** Where the token and the password live. */
  store: ResetTokenStore;
  /** "Now" — injected by the tests. */
  now?: Date;
}): Promise<ResetCompleteOutcome> {
  const { store } = args;
  const now = args.now ?? new Date();
  const token = typeof args.token === 'string' ? args.token.trim() : '';
  const password = typeof args.password === 'string' ? args.password : '';

  if (!token || !password) {
    return {
      ok: false,
      reason: 'invalid_request',
      message: 'The reset link and the new password are both needed.',
    };
  }

  // The confirmation is checked when there is one. The route always sends
  // it; the library does not insist, so a caller with only one field is
  // still held to the length rule below.
  if (args.confirm !== undefined && args.confirm !== password) {
    return {
      ok: false,
      reason: 'mismatch',
      message: 'The two passwords do not match. Type them again.',
    };
  }

  if (password.length < MIN_RESET_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'password_too_short',
      message: `A password must be at least ${MIN_RESET_PASSWORD_LENGTH} characters.`,
    };
  }

  let found: { userId: string; expiresAt: Date } | null;
  // Hashed ONCE, and the same hash is used to find the token and to spend
  // it. If the two were derived separately they would still agree — but the
  // write needs the hash, and the hash is what the store's condition is
  // written against, so it is computed here and handed over rather than
  // being recomputed inside the store from a token the store never sees.
  const tokenHash = hashResetToken(token);
  try {
    found = await store.findByTokenHash(tokenHash);
  } catch (err) {
    // A read that could not complete is NOT "no such token". It is a
    // database that did not answer, and the difference matters: one of them
    // is a failed request, the other is a failed installation.
    console.error('[auth] could not read the reset token', err);
    return {
      ok: false,
      reason: 'failed',
      message: 'Could not check that reset link. Nothing has changed — try again.',
    };
  }

  if (!found) {
    return {
      ok: false,
      reason: 'invalid_token',
      message: 'That reset link is not valid. Ask for a new one.',
    };
  }

  // An expired token is refused for the same reason as an unknown one, so
  // the page cannot be used to learn which tokens exist.
  if (found.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason: 'invalid_token',
      message: 'That reset link is not valid. Ask for a new one.',
    };
  }

  let sameAsCurrent: boolean;
  try {
    sameAsCurrent = await store.passwordMatches(found.userId, password);
  } catch (err) {
    console.error('[auth] could not read the credential for a password reset', err);
    return {
      ok: false,
      reason: 'failed',
      message: 'Could not check that account. Nothing has changed — try again.',
    };
  }
  if (sameAsCurrent) {
    return {
      ok: false,
      reason: 'must_differ',
      message: 'Choose a password you have not used here before.',
    };
  }

  // The account, read NOW.
  //
  // The link in the email named a door, and the link can be half an hour
  // old: if the role has changed since it went out, the door in the link is
  // the wrong one. So the role is read here, at the redemption, and the
  // answer is built from it.
  //
  // And this is a READ that happens BEFORE the write, because a failure to
  // read is a refusal and never a write — the rule this module has had from
  // the beginning. The role decides the door the person ends at, and the
  // tenant decides where the audit row is filed; a reset that went ahead on
  // neither would leave the person at a door they cannot use, and the trail
  // with nothing to show for it.
  let account: ResetAccountNow;
  try {
    account = await store.currentAccount(found.userId);
  } catch (err) {
    console.error('[auth] could not read the account for a password reset', err);
    return {
      ok: false,
      reason: 'failed',
      message: 'Could not check that account. Nothing has changed — try again.',
    };
  }

  try {
    await store.redeem(found.userId, tokenHash, password);
  } catch (err) {
    // The token was not live — it had already been spent, or a newer request
    // had replaced it. That is the same refusal an unknown token gets, and
    // it says nothing about whether the account exists.
    if (err instanceof ResetTokenSpentError) {
      return {
        ok: false,
        reason: 'invalid_token',
        message: 'That reset link is not valid. Ask for a new one.',
      };
    }

    // Nothing was changed: the store sets the password and spends the token
    // in one write, so a failure leaves both as they were and the person
    // can simply try again.
    console.error('[auth] the password reset could not be written', err);
    return {
      ok: false,
      reason: 'failed',
      message: 'Could not change the password. Nothing has changed — try again.',
    };
  }

  return { ok: true, userId: found.userId, account };
}
