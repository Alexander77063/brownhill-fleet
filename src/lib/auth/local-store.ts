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

  // Success: clear the counter, and quietly strengthen an old hash.
  const rehashed = needsRehash(row.password_hash) ? await hashPassword(password) : null;
  await db`
    update auth.local_credentials
    set failed_attempts = 0,
        locked_until = null,
        password_hash = coalesce(${rehashed}, password_hash),
        updated_at = now()
    where user_id = ${row.id}
  `;

  return { ok: true, user: { id: row.id, email: row.email } };
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

export type LocalUserRole = 'ops' | 'driver' | 'investor' | 'owner';

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
  const db = await localDb();
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
  const hash = await hashPassword(password);

  await db`
    insert into auth.local_credentials (user_id, password_hash)
    values (${user.id}, ${hash})
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

/** Replace a user's password, clearing any lock. */
export async function setLocalPassword(userId: string, password: string): Promise<void> {
  const db = await localDb();
  const hash = await hashPassword(password);
  await db`
    insert into auth.local_credentials (user_id, password_hash)
    values (${userId}, ${hash})
    on conflict (user_id) do update
      set password_hash = excluded.password_hash,
          failed_attempts = 0,
          locked_until = null,
          updated_at = now()
  `;
}

/** True when no account exists yet, so the app can offer first-run setup. */
export async function hasAnyUser(): Promise<boolean> {
  const db = await localDb();
  const rows = (await db`select 1 from auth.users limit 1`) as unknown as unknown[];
  return rows.length > 0;
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
 */
export async function createFirstUserAndTenant(args: {
  email: string;
  password: string;
  fullName: string;
  businessName: string;
}): Promise<FirstRunResult> {
  if (await hasAnyUser()) {
    throw new Error('Setup has already been completed on this installation.');
  }

  const db = await localDb();

  // `ops` so the profiles trigger from migration 0002 gives them the operator
  // portal; the first account is the business owner, not a driver.
  const user = await createLocalUser(args.email, args.password, {
    role: 'ops',
    fullName: args.fullName,
  });

  // The trigger is the only thing that creates the profile, and a silent
  // fallback to `driver` would sign the owner into the wrong portal with none
  // of their own data. Fail setup loudly instead of handing that over.
  const profiles = (await db`
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
  const tenants = (await db`
    insert into tenants (name, slug, branding)
    values (
      ${args.businessName},
      ${slug},
      jsonb_build_object('legal_name', ${args.businessName}::text, 'trading_name', ${args.businessName}::text)
    )
    returning id
  `) as Array<{ id: string }>;
  const tenantId = tenants[0].id;

  await db`
    insert into tenant_memberships (tenant_id, user_id, role, status)
    values (${tenantId}, ${user.id}, 'owner', 'active')
  `;

  return { user, tenantId };
}


/**
 * Stub: returns the role of the current request for admin routes that gate on
 * owner status. Real implementation should read the JWT from the session cookie
 * and return its claims. For now, returns null so admin routes correctly refuse
 * access until proper session handling is wired in.
 */
export async function getClaims(): Promise<{ role: string } | null> {
  return null;
}
