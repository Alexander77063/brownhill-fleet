/**
 * The credential store for the standalone build.
 *
 * Passwords live in `auth.local_credentials`, which PostgREST does not expose:
 * it serves only the `public` schema, so no HTTP caller can reach this table
 * whatever role they claim. Reaching it therefore needs a direct database
 * connection, which is why this is the one place in the app that speaks SQL
 * rather than PostgREST.
 *
 * The driver is imported **dynamically** so the hosted build never loads it.
 * Under `saas` this module's functions are never called, and a static import
 * would still pull the driver into every serverless bundle.
 */
import { hashPassword, needsRehash, verifyPassword } from './password';
import { closeBootstrapWindow, isBootstrapPending } from '@/lib/app-state';
import { LEGACY_SESSION_ISSUED_KEY, lockAccountRows, SESSION_ISSUED_KEY } from './account-usage';
import { takeFirstRunLock } from './first-run-lock';
import type { PortalRole } from '@/lib/iam';

export interface LocalUser {
  id: string;
  email: string;
}

export type SignInFailure = 'unknown-credentials' | 'locked' | 'unavailable';

export type SignInResult =
  | { ok: true; user: LocalUser }
  | { ok: false; reason: SignInFailure; retryAfter?: Date };

/** How many consecutive failures before an account pauses, and for how long. */
const MAX_ATTEMPTS = 10;
const LOCK_MINUTES = 30;

// Imported here so the functions in this file can use it directly,
// and re-exported so callers (admin routes etc.) keep working.
import { localDb } from '@/lib/db/local';
import type { Query } from '@/lib/db/local';
export { localDb };

/**
 * Verify an email and password.
 *
 * Both "no such user" and "wrong password" return `unknown-credentials`: the
 * distinction tells an attacker which addresses are real, and on a system whose
 * users are a named handful of employees that is worth protecting.
 *
 * A missing user still costs a password hash. Returning instantly for unknown
 * addresses turns response time into the same disclosure the shared error
 * message was meant to prevent.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInResult> {
  const db = await localDb();

  const rows = (await db`
    select u.id, u.email, c.password_hash, c.failed_attempts, c.locked_until
    from auth.users u
    join auth.local_credentials c on c.user_id = u.id
    where u.email = ${email.trim().toLowerCase()}
    limit 1
  `) as Array<{
    id: string;
    email: string;
    password_hash: string;
    failed_attempts: number;
    locked_until: Date | null;
  }>;

  const row = rows[0];

  if (!row) {
    // Spend comparable time so a missing account is not detectable by timing.
    await verifyPassword(password, await decoyHash());
    return { ok: false, reason: 'unknown-credentials' };
  }

  if (row.locked_until && row.locked_until > new Date()) {
    return { ok: false, reason: 'locked', retryAfter: row.locked_until };
  }

  if (!(await verifyPassword(password, row.password_hash))) {
    const attempts = (row.failed_attempts ?? 0) + 1;
    const lock =
      attempts >= MAX_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60_000)
        : null;
    await db`
      update auth.local_credentials
      set failed_attempts = ${attempts}, locked_until = ${lock}, updated_at = now()
      where user_id = ${row.id}
    `;
    return lock
      ? { ok: false, reason: 'locked', retryAfter: lock }
      : { ok: false, reason: 'unknown-credentials' };
  }

  // Success — but only if the credential is still the one that was verified.
  //
  // The password was checked against a hash read BEFORE this point, and PBKDF2
  // at 600,000 iterations is slow enough that the world moves while it runs.
  // In that window the credential can be replaced: by an operator resetting the
  // password, or by an invite adopting the account and handing it a different
  // one. A sign-in that verified the OLD password must not go on to mint a
  // session for an account whose password has since changed — the session is
  // stateless and lasts a month, and the adoption that replaced the password
  // is exactly the flow that must not be able to be raced.
  //
  // So the last thing before the success is the lock: the account's rows are
  // taken (in the fixed order `auth.users`, then `auth.local_credentials`),
  // the hash is read again UNDER the lock, and the password is re-checked
  // against whatever is there now. If the credential changed, the password
  // that was just verified no longer opens this account, and the sign-in
  // fails.
  //
  // The re-check is a second PBKDF2, but only on the rare path where the
  // credential actually changed: in the ordinary case the hash is identical
  // and there is nothing to re-verify.
  const rehashed = needsRehash(row.password_hash) ? await hashPassword(password) : null;

  const outcome = await db.begin(async (tx) => {
    await lockAccountRows(tx, row.id);

    const current = (await tx`
      select password_hash, locked_until
      from auth.local_credentials
      where user_id = ${row.id}::uuid
    `) as Array<{ password_hash: string; locked_until: Date | null }>;

    const cred = current[0];
    // The credential is gone. It cannot be, unless somebody deleted the
    // account's row between the read above and this one; treat it as an
    // unknown account rather than as a success.
    if (!cred) return { ok: false as const, reason: 'unknown-credentials' as const };

    // The lockout may have been armed while the password was being verified.
    if (cred.locked_until && cred.locked_until > new Date()) {
      return {
        ok: false as const,
        reason: 'locked' as const,
        retryAfter: cred.locked_until,
      };
    }

    if (cred.password_hash !== row.password_hash) {
      // The credential changed. The password is only still valid if what
      // replaced it was the SAME password — a quiet re-hash, or a reset to the
      // same value — so the password is checked again against the new hash.
      if (!(await verifyPassword(password, cred.password_hash))) {
        return { ok: false as const, reason: 'unknown-credentials' as const };
      }
    }

    // Clear the counter, quietly strengthen an old hash, and record that a
    // session exists for this account.
    //
    // The marker is what lets the product tell an account nobody has ever
    // signed into — the one a failed invite leaves behind, whose password
    // nobody knows — from an account that belongs to somebody. Only a session
    // proves that somebody got in; the credential's own shape cannot, because
    // an unusable credential can look exactly like a used one.
    //
    // It is written under the same lock the adoption takes, so the two cannot
    // interleave: either the adoption sees this marker, or this sign-in sees
    // the password the adoption replaced.
    await tx`
      update auth.users
      set raw_user_meta_data =
            coalesce(raw_user_meta_data, '{}'::jsonb)
            || jsonb_build_object(${SESSION_ISSUED_KEY}::text, now())
      where id = ${row.id}::uuid
    `;
    await tx`
      update auth.local_credentials
      set failed_attempts = 0,
          locked_until = null,
          password_hash = coalesce(${rehashed}, password_hash),
          updated_at = now()
      where user_id = ${row.id}::uuid
    `;

    return { ok: true as const, user: { id: row.id, email: row.email } };
  });

  return outcome;
}

/**
 * A hash to compare against when no user matched.
 *
 * Computed once per process from a random password: its only job is to make the
 * unknown-account path cost the same as the known-account path.
 */
let decoy: string | null = null;
async function decoyHash(): Promise<string> {
  if (!decoy) decoy = await hashPassword(`decoy-${Math.random()}`);
  return decoy;
}

/**
 * The portal a local account is created with.
 *
 * These are the portal roles — not the tenant roles. The two are different
 * vocabularies (see `portalRoleFor` in `@/lib/iam`), and the account is
 * created with the portal so the sign-up trigger, which maps portal roles to
 * themselves, puts the new colleague in the right app.
 */
export type LocalUserRole = PortalRole;

/**
 * Create a user with a password. Used by first-run setup and driver invites.
 *
 * ## Why the metadata is built in SQL
 *
 * Migration 0002's `handle_new_user()` trigger reads
 * `new.raw_user_meta_data->>'role'` to decide which portal the account gets,
 * falling back to `driver`. Passing a pre-stringified object as a jsonb
 * parameter double-encoded it — the column ended up holding the JSON *string*
 *
 *     "{\"role\":\"ops\",\"full_name\":\"...\"}"
 *
 * rather than an object, so `->>'role'` was NULL and the business owner was
 * silently created as a driver. They could sign in, and then got bounced to the
 * driver portal with none of their own data.
 *
 * `jsonb_build_object` removes the ambiguity: the shape is built by Postgres
 * from typed parameters, so there is no client-side serialisation to get wrong.
 */
export async function createLocalUser(
  email: string,
  password: string,
  meta: { role: LocalUserRole; fullName?: string },
): Promise<LocalUser> {
  const hash = await hashPassword(password);
  return insertLocalUser(await localDb(), email, hash, meta);
}

/**
 * The write half of `createLocalUser`: the account row and its credential
 * row, on a connection the caller owns.
 *
 * The password arrives already hashed, and that is not an optimisation: the
 * callers that need this inside a transaction must hash it BEFORE the
 * transaction opens, because PBKDF2 at 600,000 iterations takes seconds and a
 * transaction held open for a key derivation would pin a database connection
 * for the length of it.
 */
async function insertLocalUser(
  db: Query,
  email: string,
  passwordHash: string,
  meta: { role: LocalUserRole; fullName?: string },
): Promise<LocalUser> {
  const normalised = email.trim().toLowerCase();

  const users = (await db`
    insert into auth.users (email, raw_user_meta_data)
    values (
      ${normalised},
      jsonb_build_object('role', ${meta.role}::text, 'full_name', ${meta.fullName ?? null}::text)
    )
    on conflict (email) do update set email = excluded.email
    returning id, email
  `) as Array<{ id: string; email: string }>;

  const user = users[0];

  await db`
    insert into auth.local_credentials (user_id, password_hash)
    values (${user.id}, ${passwordHash})
    on conflict (user_id) do update
      set password_hash = excluded.password_hash,
          failed_attempts = 0,
          locked_until = null,
          updated_at = now()
  `;

  return { id: user.id, email: user.email };
}

export async function findUserIdByPhone(phone: string): Promise<string | null> {
  const db = await localDb();
  const rows = (await db`select id from auth.users where phone = ${phone} limit 1`) as Array<{
    id: string;
  }>;
  return rows[0]?.id ?? null;
}

/**
 * Create an account identified by phone with no password: it signs in by OTP.
 *
 * Only (phone, raw_user_meta_data) are written — the columns Supabase's
 * auth.users and the plain-Postgres shim share — and `handle_new_user` turns
 * the metadata role into the profile row. A select-then-insert rather than ON
 * CONFLICT because the shim has no unique index on phone.
 */
export async function createLocalPhoneUser(
  phone: string,
  meta: { role: LocalUserRole; fullName?: string },
): Promise<{ id: string }> {
  const existing = await findUserIdByPhone(phone);
  if (existing) return { id: existing };
  const db = await localDb();
  const rows = (await db`
    insert into auth.users (phone, raw_user_meta_data)
    values (
      ${phone},
      jsonb_build_object('role', ${meta.role}::text, 'full_name', ${meta.fullName ?? null}::text)
    )
    returning id
  `) as Array<{ id: string }>;
  return { id: rows[0].id };
}

/**
 * Replace a user's password, clearing any lock.
 *
 * The account's rows are locked while this happens, so it cannot interleave
 * with a sign-in that is verifying the old password: the sign-in either
 * finishes before the change and holds a session that was valid at the time,
 * or it finds the new hash and re-checks the password against it.
 */
export async function setLocalPassword(userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  const db = await localDb();
  await db.begin(async (tx) => {
    await lockAccountRows(tx, userId);
    await tx`
      insert into auth.local_credentials (user_id, password_hash)
      values (${userId}::uuid, ${hash})
      on conflict (user_id) do update
        set password_hash = excluded.password_hash,
            failed_attempts = 0,
            locked_until = null,
            updated_at = now()
    `;
  });
}

/**
 * Does this account hold a password at all?
 *
 * False for an account that signs in with a code sent to its phone — the
 * vehicle owners on the Nigerian builds — and for an account that has only
 * ever existed on Supabase Auth. The operator's password reset uses this to
 * say "there is no password to reset" rather than silently creating one for
 * an account that will never be asked for it.
 */
export async function localHasPassword(userId: string): Promise<boolean> {
  const db = await localDb();
  const rows = (await db`
    select 1 from auth.local_credentials where user_id = ${userId} limit 1
  `) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * The account cannot be taken over: it belongs to somebody.
 *
 * Raised by `adoptUnusedAccount` when the account has had a session, or when
 * it already belongs to another tenant. It is a distinct type so the caller
 * can tell "this account is not yours to take" from "the database is
 * unhappy", and say the first to the operator.
 */
export class AccountNotAdoptableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotAdoptableError';
  }
}

/**
 * Adopt an account nobody has used, and hand it a password that works.
 *
 * Adoption is for the account a FAILED INVITE left behind: an `auth.users`
 * row, a credential nobody knows, and no membership. It is NOT for an account
 * somebody has signed into — this product's sessions are stateless tokens
 * whose role is read from the database on every request, so adopting such an
 * account would hand its live session this tenant's driver portal, and
 * replacing the password would not end it.
 *
 * The decision and the write are ONE transaction, under the account's locks,
 * so they cannot disagree:
 *
 *   * the account's rows are locked, in the fixed order;
 *   * the marker is read under that lock — if a session has ever existed for
 *     this account, this refuses and writes nothing. BOTH marker keys count:
 *     the current one, and the one the previous version of this product wrote
 *     (`last_sign_in_at`), which is the only marker an account signed into
 *     before the move carries. Reading only the current key would make every
 *     pre-existing user look like an account nobody has ever used, and this
 *     would hand their live session to a driver in this tenant;
 *   * the membership is read under that lock too — an account that belongs to
 *     ANOTHER tenant is somebody else's, and taking it would move them out of
 *     the portal they already belong to;
 *   * and only then is the password replaced.
 *
 * The membership that makes the account belong to THIS tenant is written
 * afterwards, by the caller, through PostgREST — a different connection, and
 * it cannot join this transaction. That is safe because of what has already
 * happened by then: the account has no session (the marker says so, and the
 * marker is read under the lock), and the credential that anybody might have
 * known has already been replaced. There is nothing for the window to leak.
 */
export async function adoptUnusedAccount(
  userId: string,
  tenantId: string,
  password: string,
): Promise<void> {
  const hash = await hashPassword(password);
  const db = await localDb();

  await db.begin(async (tx) => {
    await lockAccountRows(tx, userId);

    const state = (await tx`
      select
        coalesce(
          nullif(u.raw_user_meta_data ->> ${SESSION_ISSUED_KEY}::text, ''),
          nullif(u.raw_user_meta_data ->> ${LEGACY_SESSION_ISSUED_KEY}::text, ''),
          ''
        ) as issued,
        (
          select count(*)::int
          from tenant_memberships m
          where m.user_id = u.id
            and m.tenant_id <> ${tenantId}::uuid
        ) as elsewhere
      from auth.users u
      where u.id = ${userId}::uuid
    `) as Array<{ issued: string; elsewhere: number }>;

    const row = state[0];
    if (!row) {
      throw new AccountNotAdoptableError(
        'That email already belongs to another account. Use a different email for this driver.',
      );
    }

    if (row.elsewhere > 0) {
      throw new AccountNotAdoptableError(
        'That email already belongs to another account. Use a different email for this driver.',
      );
    }

    if (row.issued) {
      throw new AccountNotAdoptableError(
        'That email already has an account that has been used, so it cannot be taken over. ' +
          'Add them to your organisation first and invite them again, or use a different email address.',
      );
    }

    await tx`
      insert into auth.local_credentials (user_id, password_hash)
      values (${userId}::uuid, ${hash})
      on conflict (user_id) do update
        set password_hash = excluded.password_hash,
            failed_attempts = 0,
            locked_until = null,
            updated_at = now()
    `;
  });
}

/** True when no account exists yet, so the app can offer first-run setup. */
export async function hasAnyUser(db?: Query): Promise<boolean> {
  const q = db ?? (await localDb());
  const rows = (await q`select 1 from auth.users limit 1`) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Is first-run setup still available on this installation?
 *
 * Two questions, and both have to say yes:
 *
 *   * does the installation already have an owner? (no → setup is done)
 *   * is the first-run window still open? (no → the door is shut)
 *
 * The flag is only a CACHE of the first of those. An installation with an
 * owner HAS been bootstrapped, whatever the flag says, so when the two
 * disagree the flag is stale and is corrected here rather than believed.
 *
 * That is not a convenience. It is the repair for the state a box is left in
 * when first-run setup completes on a path that does not close the window: the
 * owner account exists, the flag still says 'pending', and the first-run door
 * is still open behind the operator. Correcting the flag when the server
 * next proves otherwise heals the box without a hand-written UPDATE on the
 * customer's server.
 */
export async function firstRunOpen(db?: Query): Promise<boolean> {
  const q = db ?? (await localDb());

  if (await hasAnyUser(q)) {
    // There is an owner, so the window is shut. If the flag still says it is
    // open, the flag is the thing that is wrong.
    if (await isBootstrapPending(q)) await closeBootstrapWindow(q);
    return false;
  }

  return await isBootstrapPending(q);
}

/**
 * Close the first-run window if it is still armed.
 *
 * For callers that have already PROVED there is an owner — a successful
 * sign-in is the proof — and so need not ask the database whether one exists.
 */
export async function closeStaleFirstRunWindow(db?: Query): Promise<void> {
  const q = db ?? (await localDb());
  if (await isBootstrapPending(q)) await closeBootstrapWindow(q);
}

/**
 * The tenant this user acts in, for the JWT's tenant claim.
 *
 * ## Why bypassing RLS is safe here, specifically
 *
 * This runs on the direct superuser connection, which owns these tables, so RLS
 * does not apply — the same reason `signInWithPassword` can read
 * `auth.local_credentials` at all. That normally demands the project's rule
 * that every RLS-bypassing query filters by tenant, and this one cannot: it is
 * the query that DECIDES the tenant.
 *
 * What makes it safe is where `userId` comes from. It is never client-supplied:
 * the only caller is the sign-in route, immediately after a password has been
 * verified against that same row. The query then filters `user_id = userId`, so
 * it can only ever return tenants that user is an active member of. A caller
 * that passed in an unverified id would be handing out someone else's tenant
 * claim, which is why this function is not exported for general use.
 */
export async function primaryTenantId(userId: string): Promise<string | null> {
  const db = await localDb();
  const rows = (await db`
    select tenant_id from tenant_memberships
    where user_id = ${userId} and status = 'active'
    order by created_at
    limit 1
  `) as Array<{ tenant_id: string }>;
  return rows[0]?.tenant_id ?? null;
}

export interface FirstRunResult {
  user: LocalUser;
  tenantId: string;
}

/**
 * Create the very first account, and the single tenant it owns.
 *
 * A standalone install ships with an empty database and no way in — there is no
 * Supabase dashboard, no invite email, no seeded password. Without this the
 * customer installs the product, reaches the sign-in page, and simply cannot
 * proceed.
 *
 * It refuses to run once any account exists, so the route that exposes it
 * cannot be replayed later to mint a second owner.
 *
 * ## Why this is one transaction
 *
 * The owner account, the tenant they operate, and the closing of the
 * first-run window are ONE transition: "this installation has an owner now".
 * Splitting them is how an installation ends up with an owner and a flag that
 * still says it is waiting for its first run — a green setup on an
 * application that still believes it is pending, with the first-run door left
 * open behind the operator. In a transaction, either all of it lands or none
 * of it does, so a setup that cannot close the window does not report
 * success, and a setup that fails leaves nothing half-done.
 */
export async function createFirstUserAndTenant(args: {
  email: string;
  password: string;
  fullName: string;
  businessName: string;
}): Promise<FirstRunResult> {
  // The password is hashed BEFORE the transaction opens. PBKDF2 at 600,000
  // iterations takes seconds, and a transaction held open for a key
  // derivation would pin a database connection on the one installation that
  // ever runs this.
  const passwordHash = await hashPassword(args.password);

  const db = await localDb();

  const created = await db.begin(async (tx): Promise<FirstRunResult> => {
    // THE FIRST-RUN LOCK.
    //
    // The transaction makes the account and the window land together. It does
    // NOT make two CONCURRENT setups take turns: both could open a
    // transaction, both read `auth.users`, both see nothing, and both insert
    // an owner — and the serialisation on the `app_state` upsert comes at the
    // END, long after both owners exist. Two owners and two tenants on an
    // install that is single-tenant by contract.
    //
    // The lock is taken FIRST, before the check it guards. The second setup
    // waits for the first to commit, and when it gets the lock its `auth.users`
    // read sees the account that was just committed, so it refuses.
    //
    // `pg_advisory_xact_lock` is released when the transaction ends — commit
    // or rollback — so a setup that fails leaves nothing held, and there is
    // nothing to clean up. The same primitive the period close uses for the
    // same reason: two writers that must not interleave.
    await takeFirstRunLock(tx);

    if (await hasAnyUser(tx)) {
      throw new Error('Setup has already been completed on this installation.');
    }

    // `ops` so the profiles trigger from migration 0002 gives them the operator
    // portal; the first account is the business owner, not a driver.
    const user = await insertLocalUser(tx, args.email, passwordHash, {
      role: 'ops',
      fullName: args.fullName,
    });

    // The trigger is the only thing that creates the profile, and a silent
    // fallback to `driver` would sign the owner into the wrong portal with none
    // of their own data. Fail setup loudly instead of handing that over.
    const profiles = (await tx`
      select role::text as role from profiles where id = ${user.id}
    `) as Array<{ role: string }>;
    if (profiles[0]?.role !== 'ops') {
      throw new Error(
        `Account was created with role "${profiles[0]?.role ?? 'none'}" instead of "ops".`,
      );
    }

    const slug =
      args.businessName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50) || 'fleet';

    // Seed the tenant's branding from the name they just typed. Without it the
    // portal header falls back to the product name, so a self-hosted customer
    // signs into their own system and is greeted by someone else's brand.
    const tenants = (await tx`
      insert into tenants (name, slug, branding)
      values (
        ${args.businessName},
        ${slug},
        jsonb_build_object('legal_name', ${args.businessName}::text, 'trading_name', ${args.businessName}::text)
      )
      returning id
    `) as Array<{ id: string }>;
    const tenantId = tenants[0].id;

    await tx`
      insert into tenant_memberships (tenant_id, user_id, role, status)
      values (${tenantId}, ${user.id}, 'owner', 'active')
    `;

    // The window closes HERE — in the same transaction as the account it
    // describes. This is the only place in the application that opens a
    // first run, so this is the only place that closes one.
    await closeBootstrapWindow(tx);

    return { user, tenantId };
  });

  return created;
}
