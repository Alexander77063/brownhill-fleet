/**
 * Resetting a member's password — the operator's tool.
 *
 * WHY THIS EXISTS
 * ---------------
 * The product had no way to recover a forgotten password from inside the app.
 * Both portal sign-in pages carried a "Forgot password?" link that pointed at
 * a page behind their own layout — `/driver/login` linked to `/driver/profile`,
 * `/owner/login` to `/owner/settings/security` — so a locked-out user was
 * bounced straight back to the sign-in form, in a loop, with no way out.
 *
 * The only mechanism that worked was `set-customer-password.mjs`: a script on
 * the customer's own box, needing SSH and a `DATABASE_URL`. A driver who
 * forgot their password had to phone the office, and the office had to log in
 * to the customer's server. That is not a recovery path, it is an incident.
 *
 * This module is the decision half of the in-app replacement. The store is
 * injected so every branch — a member of another tenant, an account with no
 * password, a failed email, a failed write, a privilege escalation — runs
 * without a database, the same shape `src/lib/auth/owner-signin.ts` uses.
 *
 * THE TEMPORARY PASSWORD
 * ----------------------
 * It is read out over the telephone, so the alphabet avoids the characters
 * people confuse when reading them aloud: no 1, i, l, O or o. Zero is kept,
 * because capital O and lowercase o are not. The alphabet has 32 characters,
 * so each position carries exactly 5 bits, and the 32-character password
 * carries 160 of them. That cannot be guessed, and it does not need to be
 * short-lived for its own sake — the account owner is told to change it once
 * they are in.
 */
import { randomBytes } from 'node:crypto';
import { assertCanResetPassword } from '@/lib/iam';

/**
 * 32 characters: digits 2-9 and 0, and every lowercase letter except i, l and
 * o. Deliberately *not* a power-of-two-friendly alphabet by accident — it is
 * exactly 32, so one byte maps to one character with no modulo bias.
 */
export const READABLE_ALPHABET = '023456789abcdefghjkmnpqrstuvwxyz';

/** How long a temporary password is. */
export const TEMP_PASSWORD_LENGTH = 32;

/**
 * A temporary password, from the system CSPRNG.
 *
 * Bytes at or above 224 are rejected rather than folded in, so every
 * character of the alphabet is equally likely (a plain `byte % 32` would
 * favour the first eight characters by a factor of two).
 */
export function generateTemporaryPassword(length: number = TEMP_PASSWORD_LENGTH): string {
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 224) continue; // the tail of the byte range — reject it
      out.push(READABLE_ALPHABET[byte % READABLE_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** The member being reset, as far as the reset needs to know. */
export interface ResetMember {
  userId: string;
  email: string | null;
  fullName: string | null;
  /** The tenant role — used by the escalation guard. */
  role: string;
  status: string;
}

/**
 * Everything the reset needs from the outside world.
 *
 * `findMember` is tenant-scoped **by contract**: the implementation filters on
 * the tenant id, so a user who belongs to another tenant is not found and
 * nothing is reset.
 */
export interface PasswordResetStore {
  /** The member, if they belong to this tenant. */
  findMember(tenantId: string, userId: string): Promise<ResetMember | null>;
  /**
   * Every membership this user holds, in every tenant.
   *
   * This one is deliberately NOT tenant-scoped. The password is a single
   * credential for the whole user — `auth.local_credentials` is keyed by user
   * id — so a reset is not confined to the tenant the operator happens to be
   * looking at. It changes the credential that opens every account the person
   * has. The guard therefore has to see the other tenants too.
   */
  findMemberships(
    userId: string,
  ): Promise<Array<{ tenantId: string; role: string; status: string }>>;
  /**
   * Does this account hold a password at all?
   *
   * False for an account that signs in with a code sent to their phone — the
   * vehicle owners on the Nigerian builds. There is nothing to reset there,
   * and saying so is more use than pretending to reset a password that was
   * never used.
   */
  hasPassword(userId: string): Promise<boolean>;
  /** Replace the password, and clear any lockout on the account. */
  setPassword(userId: string, password: string): Promise<void>;
  /** Deliver the temporary password. `sent: false` means it did not go. */
  deliverTemporaryPassword(member: ResetMember, password: string): Promise<{ sent: boolean; reason?: string }>;
}

export type PasswordResetOutcome =
  | {
      ok: true;
      /** The temporary password, for the operator to hand over. */
      temporaryPassword: string;
      /** True when the password was emailed as well as shown. */
      emailed: boolean;
      member: ResetMember;
    }
  | {
      ok: false;
      reason: 'not_found' | 'no_password' | 'forbidden' | 'failed';
      /** Human-readable text, for the panel. */
      message: string;
    };

/**
 * Reset one member's password.
 *
 * The order of the checks matters. The member is looked up **within the
 * caller's tenant** first, so a user id from another tenant is simply not
 * found; the escalation guard comes next, because resetting somebody's
 * password is signing in as them and must not be a way around the role
 * guard; then the SAME guard is applied to every OTHER tenant the target
 * belongs to, because the credential is one credential for the whole user;
 * and only then is a password written.
 *
 * A failure to email is not a failure of the reset — the password has already
 * been changed by then, and the operator can read it off the screen.
 */
export async function resetMemberPassword(args: {
  tenantId: string;
  userId: string;
  /** The caller's tenant role — the escalation guard is measured against it. */
  callerRole: string | null;
  /**
   * The caller's role in each tenant they belong to, keyed by tenant id.
   *
   * Used to authorise the reset in the target's OTHER tenants. The caller's
   * own tenant is covered by `callerRole`; this is the rest of them.
   */
  callerRoles?: Readonly<Record<string, string>>;
  store: PasswordResetStore;
  /** Injected in tests; the CSPRNG in production. */
  generate?: () => string;
}): Promise<PasswordResetOutcome> {
  const { tenantId, userId, store } = args;
  const generate = args.generate ?? generateTemporaryPassword;

  const member = await store.findMember(tenantId, userId);
  if (!member) {
    return {
      ok: false,
      reason: 'not_found',
      message: 'That person is not a member of this organisation.',
    };
  }

  try {
    assertCanResetPassword(member.role, args.callerRole);
  } catch (err) {
    return {
      ok: false,
      reason: 'forbidden',
      message: err instanceof Error ? err.message : 'You cannot reset that account.',
    };
  }

  // The same guard, for every other tenant the target belongs to.
  //
  // `auth.local_credentials` is keyed by user id. There is one password for
  // a person and it opens every account they hold, so a reset authorised
  // only in the caller's own tenant is a reset that also lands in every
  // other one. The caller must be authorised to reset the target's role in
  // each of those too.
  //
  // On the single-tenant profiles — standalone, hosted, managed — there is no
  // other tenant, so this loop is empty and nothing changes. It matters on
  // `managed-shared`, which is multi-tenant and uses these local credentials.
  const memberships = await store.findMemberships(userId);
  for (const other of memberships) {
    if (other.tenantId === tenantId) continue; // already guarded above
    if (other.status !== 'active') continue; // grants nothing, so withholds nothing

    const callerRoleThere = args.callerRoles?.[other.tenantId];
    if (!callerRoleThere) {
      return {
        ok: false,
        reason: 'forbidden',
        message:
          'That account is also used in another organisation, and you have no authority there. Ask that organisation to reset it instead.',
      };
    }

    try {
      assertCanResetPassword(other.role, callerRoleThere);
    } catch (err) {
      return {
        ok: false,
        reason: 'forbidden',
        message: err instanceof Error ? err.message : 'You cannot reset that account.',
      };
    }
  }

  if (!(await store.hasPassword(userId))) {
    return {
      ok: false,
      reason: 'no_password',
      message:
        'This account signs in with a code sent to their phone number — there is no password to reset.',
    };
  }

  const temporaryPassword = generate();
  try {
    await store.setPassword(userId, temporaryPassword);
  } catch (err) {
    console.error('[auth] password reset failed', userId, err);
    return {
      ok: false,
      reason: 'failed',
      message: 'Could not set the new password. Nothing has changed — try again.',
    };
  }

  let emailed = false;
  try {
    const sent = await store.deliverTemporaryPassword(member, temporaryPassword);
    emailed = sent.sent;
  } catch (err) {
    // The password HAS changed. Reporting this as a failure would tell the
    // operator nothing changed, and the account would be locked to a password
    // nobody has.
    console.error('[auth] could not deliver the temporary password', userId, err);
    emailed = false;
  }

  return { ok: true, temporaryPassword, emailed, member };
}
