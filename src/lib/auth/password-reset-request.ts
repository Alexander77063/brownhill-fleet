/**
 * The request half of the self-service password reset: somebody asks for a
 * reset, and a link is sent to them.
 *
 * WHY THIS EXISTS
 * ---------------
 * The token half is `src/lib/auth/password-reset-token.ts`. This is the half
 * that faces the outside world, and it has one job above every other: it must
 * not tell a stranger whether an address is registered.
 *
 * If "we sent you a link" and "no such account" are different answers, then
 * the page is a way to enumerate who has an account with this operator — and
 * the person most likely to run that is exactly the person trying to take
 * one over. So the RESULT HAS ONE SHAPE: the same four keys, always present,
 * for every account state. What differs between them is the `outcome` code,
 * and that code is for the operator's own record, never for the browser.
 *
 * A result that gained or lost a key would be a result the route could leak
 * by accident, so the shape is pinned by a test rather than by a convention.
 *
 * WHAT IS NOT HERE
 * ----------------
 * No session, no tenant. A reset link goes to the address on file, and the
 * address on file is the only thing that decides where it goes — not the
 * address that was typed, and not anything the caller claims.
 *
 * The account's ROLE is carried, because the link has to end at the right
 * door: a driver reset back at the staff sign-in signs in successfully and is
 * then bounced by the role check. The role comes from the row on file, never
 * from the request.
 *
 * The store is injected, so every branch runs without a database — the same
 * shape `src/lib/auth/password-reset.ts` uses for the operator's reset.
 */
import {
  generateResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_SECONDS,
} from '@/lib/auth/password-reset-token';

/** The account a reset link can be sent to. */
export interface ResetAccount {
  userId: string;
  /** The address on file. The link goes here, not to the address typed. */
  email: string;
  fullName: string | null;
  /** The tenant, for the email's branding and sender. */
  tenantId: string | null;
  /**
   * The portal role on file: `driver`, `owner`, `ops`, `accounts`,
   * `investor`, or empty when the account has no profile row.
   *
   * It decides which sign-in page the link sends the person to. It is read
   * from the database and is not, at any point, something the caller supplies.
   */
  role: string;
}

/** Everything the request needs from the outside world. */
export interface ResetRequestStore {
  /** The account for an address, or null when there is none. */
  findAccountByEmail(email: string): Promise<ResetAccount | null>;
  /**
   * Does this account hold a password at all?
   *
   * False for an account that signs in with a code sent to their phone.
   * There is no password to reset there, and sending a link would create one
   * — and with it a second way into an account that deliberately has one.
   */
  hasPassword(userId: string): Promise<boolean>;
  /** Record a token hash and its expiry, replacing any earlier token. */
  issueToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
}

/**
 * What happened.
 *
 * 'sent' is the only one that means a person will receive a link. The rest
 * are for the operator's record.
 */
export type ResetRequestOutcomeCode =
  | 'sent'
  | 'no_such_account'
  | 'no_password'
  | 'throttled'
  | 'store_failed'
  | 'delivery_failed';

/**
 * The result. One shape for every account state — that is the whole point.
 */
export interface ResetRequestResult {
  /** Always true: the request was understood. */
  ok: true;
  /** What happened. For the operator's record; never for the browser. */
  outcome: ResetRequestOutcomeCode;
  /** The raw token, when one was issued. For the link. Never in a response. */
  token: string | null;
  /** When the link stops working. */
  expiresAt: Date | null;
}

/** A result with no token and no expiry — the shape every failure uses. */
function nothing(outcome: ResetRequestOutcomeCode): ResetRequestResult {
  return { ok: true, outcome, token: null, expiresAt: null };
}

/**
 * Ask for a reset link.
 *
 * The link is sent by the injected `deliver` function, which is where the
 * email lives — so this module has no opinion about which provider sends it.
 *
 * Every branch returns the SAME SHAPE. The caller cannot tell from the
 * result whether the address is registered, and the browser is told the same
 * thing either way.
 */
export async function requestPasswordReset(args: {
  /** The address the person typed. */
  email: string;
  /** Where the account and the token live. */
  store: ResetRequestStore;
  /** Send the link. */
  deliver: (args: {
    account: ResetAccount;
    token: string;
    expiresAt: Date;
  }) => Promise<{ sent: boolean; reason?: string }>;
  /**
   * May this account be sent a link right now?
   *
   * The throttle. It is asked AFTER the account has been found — so only an
   * account that exists is ever asked, and a stranger's guesses never spend
   * a real person's allowance — and BEFORE the token is issued, so a request
   * that is over the allowance does not mint a token it will never send.
   *
   * The allowance is TAKEN here, not counted after the fact. An allowance
   * that is counted after the mail has gone out has already been spent by
   * the time it is counted, which is how a hundred concurrent requests all
   * passed a limit of three.
   *
   * Absent, the link goes out — which is what the operator's own reset
   * does, and what any caller that does not have a throttle wants.
   */
  allowSend?: (account: ResetAccount) => Promise<boolean>;
  /** "Now" — injected by the tests. */
  now?: Date;
  /** The token source — the CSPRNG in production, a fixed one in the tests. */
  generate?: () => string;
}): Promise<ResetRequestResult> {
  const now = args.now ?? new Date();
  const generate = args.generate ?? generateResetToken;
  const email = typeof args.email === 'string' ? args.email.trim() : '';

  // An empty address is not an account. It is answered like every other
  // miss, so that the shape of the answer carries nothing.
  if (!email) return nothing('no_such_account');

  let account: ResetAccount | null;
  try {
    account = await args.store.findAccountByEmail(email);
  } catch (err) {
    // A read that failed is NOT an account that does not exist. Nothing is
    // sent either way, but the two must not look the same in the log, or a
    // broken database would look like a clean run.
    console.error('[auth] could not read the account for a password reset', err);
    return nothing('store_failed');
  }
  if (!account) return nothing('no_such_account');

  let hasPassword: boolean;
  try {
    hasPassword = await args.store.hasPassword(account.userId);
  } catch (err) {
    console.error('[auth] could not read the credential for a password reset', err);
    return nothing('store_failed');
  }
  if (!hasPassword) return nothing('no_password');

  // The account's own allowance, taken before anything is sent.
  if (args.allowSend) {
    let allowed: boolean;
    try {
      allowed = await args.allowSend(account);
    } catch (err) {
      console.error('[auth] could not check the password reset allowance', err);
      return nothing('store_failed');
    }
    if (!allowed) {
      // Nothing is sent, and nothing is stored: a token that was issued and
      // never sent is a live token on the account that nobody has.
      return nothing('throttled');
    }
  }

  const token = generate();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_SECONDS * 1000);

  try {
    // Only the HASH is stored. A database that leaks must not hand out live
    // reset links.
    await args.store.issueToken(account.userId, hashResetToken(token), expiresAt);
  } catch (err) {
    console.error('[auth] could not store the reset token', err);
    // A link whose token was never stored is a link that will not work. It
    // is better to send nothing than to send a link that fails.
    return nothing('store_failed');
  }

  let sent: { sent: boolean; reason?: string };
  try {
    sent = await args.deliver({ account, token, expiresAt });
  } catch (err) {
    console.error('[auth] the reset link could not be sent', err);
    return nothing('delivery_failed');
  }
  if (!sent.sent) {
    // The box may have no email provider configured. The operator needs to
    // know that, so it is recorded — and the person still gets the same
    // answer as everybody else.
    console.error('[auth] the reset link did not go out', sent.reason ?? 'no reason given');
    return nothing('delivery_failed');
  }

  return { ok: true, outcome: 'sent', token, expiresAt };
}
