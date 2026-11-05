/**
 * The self-service password reset, over the local database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The decision half of the reset lives in two modules that need no database:
 *
 *   * `src/lib/auth/password-reset-request.ts` — somebody asks for a reset;
 *   * `src/lib/auth/password-reset-token.ts` — somebody redeems a token.
 *
 * Both take their store as an argument, which is what lets every branch be
 * tested without a database. This file is the store they are given in
 * production: the SQL over the direct connection that owns
 * `auth.local_credentials`.
 *
 * WHY SQL AND NOT PostgREST
 * -------------------------
 * `auth.local_credentials` is revoked from `anon`, `authenticated` and
 * `service_role`, so no HTTP caller can reach it whatever role they claim.
 * Reaching it needs the direct connection — the same reason
 * `src/lib/auth/local-store.ts` speaks SQL rather than PostgREST.
 *
 * WHAT THE SQL HAS TO GET RIGHT
 * ------------------------------
 *   * The redemption sets the new password AND spends the token in ONE
 *     statement, and only WHILE the token being redeemed is still the live
 *     one. Two statements would leave a window in which the password had
 *     changed but the link still worked, so a forwarded link would be good
 *     twice; a write that is not conditional on the token would leave the
 *     same window open for two redemptions racing each other.
 *   * The redemption takes the account's row locks first, so it cannot
 *     interleave with a sign-in that is verifying the old password.
 *   * The token is found by its HASH. A lookup by the token would mean the
 *     token was stored somewhere it could be read.
 *   * A token with no expiry is a token that has EXPIRED. Reading a NULL as
 *     "no limit" would be a link that never dies.
 *   * The address the link goes to is the address ON FILE. The typed address
 *     selects the account; it never decides where the link is sent.
 */
import { localDb } from '@/lib/db/local';
import type { Sql } from 'postgres';
import { lockAccountRows } from './account-usage';
import { hashPassword, verifyPassword } from './password';
import type { ResetAccount, ResetRequestStore } from './password-reset-request';
import {
  MAX_RESET_REQUESTS_PER_ACCOUNT_15M,
  MAX_RESET_REQUESTS_PER_IP_1H,
  RESET_ACCOUNT_WINDOW_MINUTES,
  RESET_IP_WINDOW_MINUTES,
  RESET_REQUEST_RETENTION_MINUTES,
  windowStart,
  type ResetThrottleStore,
} from './password-reset-throttle';
import { ResetTokenSpentError, type ResetAccountNow, type ResetTokenStore } from './password-reset-token';

/** A row of `auth.local_credentials`, as the queries return it. */
interface CredentialRow {
  user_id: string;
  password_hash: string;
  reset_expires_at: Date | string | null;
}

/** A row of the account lookup. */
interface AccountRow {
  user_id: string;
  email: string;
  full_name: string | null;
  tenant_id: string | null;
  role: string | null;
}

/**
 * The key derivation, injected.
 *
 * PBKDF2 at 600,000 iterations is the product's deliberate cost, and it is
 * slow on purpose. Injecting it keeps the store's test — whose subject is the
 * SQL — from paying that cost ten times over, while the production default
 * below stays exactly the real thing. The derivation itself is covered by
 * `tests/unit/password.test.ts`.
 */
export interface ResetStoreCrypto {
  /** Derive the stored form of a password. */
  hash(password: string): Promise<string>;
  /** Is this password the one that is stored? */
  verify(password: string, stored: string): Promise<boolean>;
}

/** The production derivation. */
export const REAL_RESET_CRYPTO: ResetStoreCrypto = {
  hash: hashPassword,
  verify: verifyPassword,
};

/**
 * The token store, over a connection the caller owns.
 *
 * The connection is injected so the SQL can be exercised without a database —
 * the same shape `src/lib/auth/password-reset.ts` uses for the operator's
 * reset.
 *
 * The type is the POOL (`postgres.Sql`), not the query interface, because the
 * redemption needs `begin()`: the password and the spent token have to land
 * in one transaction, and only the pool can open one.
 */
export function makeLocalResetTokenStore(
  db: Sql,
  crypto: ResetStoreCrypto = REAL_RESET_CRYPTO,
): ResetTokenStore {
  return {
    /**
     * Record a token hash and its expiry, replacing any earlier token.
     *
     * One live token per account: a second request must stop the first link
     * from working, or a link that was already forwarded keeps working for
     * the whole of its window.
     *
     * `updated_at` is deliberately NOT touched. The credential did not change
     * — a token was issued against it — and the column records when the
     * password was last written.
     */
    async issue(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
      const rows = (await db`
        update auth.local_credentials
        set reset_token_hash = ${tokenHash},
            reset_expires_at = ${expiresAt.toISOString()}::timestamptz
        where user_id = ${userId}::uuid
        returning user_id::text as user_id
      `) as unknown as CredentialRow[];

      // The credential has to be there — it is what the token is issued
      // against. If it is not, the update changed nothing and the link we
      // were about to send would never work.
      if (!rows[0]) {
        throw new Error('The account no longer has a password to reset.');
      }
    },

    /**
     * The account a token belongs to, and when it stops working.
     *
     * Null when the token is unknown — which includes one that has already
     * been used, because redemption clears it.
     *
     * This read cannot promise the token is still live: a redemption in
     * flight right now may spend it before this call returns. The write's
     * condition is what makes the link single-use, not this read.
     */
    async findByTokenHash(
      tokenHash: string,
    ): Promise<{ userId: string; expiresAt: Date } | null> {
      const rows = (await db`
        select user_id::text as user_id, reset_expires_at
        from auth.local_credentials
        where reset_token_hash = ${tokenHash}
        limit 1
      `) as unknown as CredentialRow[];

      const row = rows[0];
      if (!row) return null;

      // A token with no expiry is EXPIRED, not unlimited. The library checks
      // the expiry, so a NULL has to arrive here as a time in the past.
      const expiresAt = row.reset_expires_at
        ? new Date(row.reset_expires_at)
        : new Date(0);

      return { userId: row.user_id, expiresAt };
    },

    /**
     * Is this the password the account already holds?
     *
     * The comparison lives here because this is where the stored hash is.
     */
    async passwordMatches(userId: string, password: string): Promise<boolean> {
      const rows = (await db`
        select password_hash
        from auth.local_credentials
        where user_id = ${userId}::uuid
        limit 1
      `) as unknown as CredentialRow[];

      const row = rows[0];
      if (!row) return false;
      return crypto.verify(password, row.password_hash);
    },

    /**
     * Set the new password and spend the token, in one write.
     *
     * The hash is derived BEFORE the transaction opens: PBKDF2 at 600,000
     * iterations takes seconds, and a transaction held open for a key
     * derivation would pin a database connection for the length of it.
     *
     * THE CONDITION IS THE SINGLE-USE PROPERTY
     * -----------------------------------------
     * The write is conditional on the token being redeemed STILL being the
     * token on the account. That is what makes the link good for one use.
     *
     * Writing `reset_token_hash = null` alone does not do it: that spends
     * WHATEVER token the row holds, whether or not it is the one being
     * redeemed, and it does so in a window that another redemption can slip
     * into. Two people holding the same forwarded link could both be told
     * "your password has been changed", and the second one's password would
     * be the one that stood while the first person's own reset silently
     * failed.
     *
     * With the hash in the `WHERE` clause, the second redemption matches no
     * row, changes nothing, and is refused. The first redemption's password
     * is the one that stands. This was proved against a real Postgres, with
     * two sessions and the first write held open — see
     * `tests/integration/auth/password-reset-single-use.test.ts`.
     */
    async redeem(userId: string, tokenHash: string, password: string): Promise<void> {
      const hash = await crypto.hash(password);

      await db.begin(async (tx) => {
        // The account's locks, in the fixed order. This is what stops the
        // reset from interleaving with a sign-in that is verifying the old
        // password: the two cannot disagree about what the password is.
        await lockAccountRows(tx, userId);

        // ONE statement. The password and the spent token land together, or
        // neither does — AND the row is only updated while the token being
        // redeemed is still the live one.
        const rows = (await tx`
          update auth.local_credentials
          set password_hash = ${hash},
              reset_token_hash = null,
              reset_expires_at = null,
              failed_attempts = 0,
              locked_until = null,
              updated_at = now()
          where user_id = ${userId}::uuid
            and reset_token_hash = ${tokenHash}
          returning user_id::text as user_id
        `) as unknown as CredentialRow[];

        // No row. Either the credential has gone — the account was deleted
        // between the request and the redemption — or the token is no longer
        // the live one, which is what a link that has already been used
        // looks like from here.
        //
        // Both are the same answer, and it is deliberately NOT a generic
        // failure: a failure says "try again", and trying again would never
        // work for a link that has been spent.
        if (!rows[0]) {
          throw new ResetTokenSpentError();
        }
      });
    },

    /**
     * The account as it is NOW — its role, and the tenants it belongs to.
     *
     * Read at the REDEMPTION, not when the link was sent: the link can be
     * half an hour old, and a role that changed in that time must change
     * where the person is sent next.
     *
     * The role comes from the account's own profile row. The tenant list
     * comes from its ACTIVE memberships, which is the set of tenants the
     * password actually opens — and the set the audit row has to be filed
     * under.
     *
     * A user with no profile row has no role, and no role means the staff
     * door. A user with no active membership belongs to no tenant, and the
     * audit row then has nowhere to go — which is reported loudly rather
     * than quietly dropped.
     */
    async currentAccount(userId: string): Promise<ResetAccountNow> {
      const rows = (await db`
        select coalesce(p.role::text, '') as role,
               coalesce(
                 array_agg(m.tenant_id::text) filter (where m.tenant_id is not null),
                 '{}'::text[]
               ) as tenant_ids
          from auth.users u
          left join profiles p on p.id = u.id
          left join tenant_memberships m
                 on m.user_id = u.id
                and m.status = 'active'
         where u.id = ${userId}::uuid
         group by p.role
      `) as unknown as Array<{ role: string | null; tenant_ids: string[] | null }>;

      const row = rows[0];
      // No row means no account — which cannot happen for a token that was
      // found, because the token lives on that account's own credential row.
      // But "cannot happen" is not a reason to hand back an empty account:
      // a read that cannot answer has to fail, so the redemption refuses
      // rather than guessing a role and a tenant.
      if (!row) {
        throw new Error('The account could not be read.');
      }

      return { role: row.role ?? '', tenantIds: row.tenant_ids ?? [] };
    },
  };
}

/**
 * The request store, over a connection the caller owns.
 *
 * The account lookup returns the address ON FILE, not the address that was
 * typed. The typed address only ever selects the account; where the link
 * goes is decided by the row.
 */
export function makeLocalResetRequestStore(
  db: Sql,
  crypto: ResetStoreCrypto = REAL_RESET_CRYPTO,
): ResetRequestStore {
  const tokens = makeLocalResetTokenStore(db, crypto);

  return {
    async findAccountByEmail(email: string): Promise<ResetAccount | null> {
      const rows = (await db`
        select u.id::text as user_id,
               u.email::text as email,
               p.full_name,
               p.role::text as role,
               (
                 select m.tenant_id::text
                 from tenant_memberships m
                 where m.user_id = u.id
                   and m.status = 'active'
                 order by m.created_at
                 limit 1
               ) as tenant_id
        from auth.users u
        left join profiles p on p.id = u.id
        where lower(u.email::text) = ${email.trim().toLowerCase()}
        limit 1
      `) as unknown as AccountRow[];

      const row = rows[0];
      if (!row) return null;

      return {
        userId: row.user_id,
        email: row.email,
        fullName: row.full_name,
        tenantId: row.tenant_id,
        // An account with no profile row has no role, and no role means the
        // staff door. The caller decides what that means; here it is only
        // ever the truth about the row.
        role: row.role ?? '',
      };
    },

    /**
     * Does this account hold a password at all?
     *
     * False for an account that signs in with a code sent to their phone.
     * There is no password to reset there, and sending a link would create
     * one — and with it a second way into an account that deliberately has
     * one.
     */
    async hasPassword(userId: string): Promise<boolean> {
      const rows = (await db`
        select 1 from auth.local_credentials where user_id = ${userId}::uuid limit 1
      `) as unknown as unknown[];
      return rows.length > 0;
    },

    async issueToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
      await tokens.issue(userId, tokenHash, expiresAt);
    },
  };
}

/** The token store, over the connection this installation owns. */
export async function localResetTokenStore(): Promise<ResetTokenStore> {
  return makeLocalResetTokenStore(await localDb());
}

/** The request store, over the connection this installation owns. */
export async function localResetRequestStore(): Promise<ResetRequestStore> {
  return makeLocalResetRequestStore(await localDb());
}

/**
 * The throttle, over the connection this installation owns.
 *
 * WHY THE ALLOWANCE IS TAKEN AND NOT COUNTED
 * -------------------------------------------
 * The security review of 2026-11-04 found the counter being incremented
 * AFTER the mail had gone out, so a hundred concurrent requests all passed
 * a limit of three. Taking the allowance means the check and the record
 * land in ONE transaction, so the second request sees the first one's
 * record.
 *
 * And the transaction takes an ADVISORY LOCK on the allowance it is
 * spending. Without it, two transactions can both read a count of two,
 * both conclude there is room, and both write — which is the same defect
 * one layer down. Postgres runs transactions at READ COMMITTED, so a plain
 * read-then-write is two independent snapshots of the world.
 *
 * The lock is on a HASH of the allowance's key, so the two allowances — one
 * per caller, one per account — do not block each other, and two callers
 * at once are serialised against each other rather than against a global
 * lock that every reset request on the box would queue behind.
 *
 * WHY THE TABLE HOLDS NO ADDRESS
 * ------------------------------
 * The row holds the CALLER's address and the ACCOUNT the request turned
 * out to belong to. It does not hold the address that was typed: that
 * address belongs to whoever typed it, and keeping a column of them would
 * be keeping a list of who is on file — and of who is not.
 *
 * It also means the table cannot be the answer to "who has an account
 * here?", because it never held the addresses.
 */
export function makeLocalResetThrottleStore(db: Sql): ResetThrottleStore {
  return {
    async takeIpAllowance({ ip, now }) {
      return db.begin(async (tx) => {
        // The lock is taken before the count and held until the
        // transaction ends, so two requests for the same caller cannot both
        // read the same count.
        if (ip) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${`reset-ip:${ip}`}, 0))`;

          const rows = (await tx`
            select count(*)::int as n
              from password_reset_requests
             where requested_ip = ${ip}
               and created_at > ${windowStart(now, RESET_IP_WINDOW_MINUTES).toISOString()}::timestamptz
          `) as unknown as Array<{ n: number }>;

          if ((rows[0]?.n ?? 0) >= MAX_RESET_REQUESTS_PER_IP_1H) {
            return { allowed: false, requestId: null };
          }
        }

        // The request is recorded whether or not the address it named is on
        // file. That is what makes the allowance bite: a stranger guessing
        // addresses spends the same allowance a real person's request
        // spends, and a stranger's guesses never reach the per-account
        // allowance at all.
        const inserted = (await tx`
          insert into password_reset_requests (requested_ip)
          values (${ip})
          returning id::text as id
        `) as unknown as Array<{ id: string }>;

        // The prune keeps the table from growing without bound. It runs in
        // the same transaction as the reservation, so there is no window in
        // which the table has grown and not been pruned — and it runs on
        // every request, which is exactly as often as the table grows.
        //
        // The retention is twice the longest window, so a request can never
        // be pruned while it is still counting towards an allowance.
        await tx`
          delete from password_reset_requests
           where created_at < ${windowStart(now, RESET_REQUEST_RETENTION_MINUTES).toISOString()}::timestamptz
        `;

        return { allowed: true, requestId: inserted[0]?.id ?? null };
      });
    },

    async takeAccountAllowance({ requestId, accountId, now }) {
      return db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`reset-account:${accountId}`}, 0))`;

        const rows = (await tx`
          select count(*)::int as n
            from password_reset_requests
           where account_id = ${accountId}::uuid
             and created_at > ${windowStart(now, RESET_ACCOUNT_WINDOW_MINUTES).toISOString()}::timestamptz
        `) as unknown as Array<{ n: number }>;

        if ((rows[0]?.n ?? 0) >= MAX_RESET_REQUESTS_PER_ACCOUNT_15M) {
          return { allowed: false };
        }

        // The request is attached to the account, which is what the
        // allowance above counts. Attaching it and counting it are in one
        // transaction, so a request that has spent the allowance is
        // attached, and a request that is over the allowance is not.
        await tx`
          update password_reset_requests
             set account_id = ${accountId}::uuid
           where id = ${requestId}::uuid
        `;

        return { allowed: true };
      });
    },
  };
}

/** The throttle, over the connection this installation owns. */
export async function localResetThrottleStore(): Promise<ResetThrottleStore> {
  return makeLocalResetThrottleStore(await localDb());
}
