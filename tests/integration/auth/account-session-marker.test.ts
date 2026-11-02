// tests/integration/auth/account-session-marker.test.ts
//
// The marker that says "somebody has been in this account", against a real
// postgres.
//
// WHY THIS FILE EXISTS
// --------------------
//
// The driver invite may ADOPT an account that belongs to no tenant — that is
// the account an earlier failed invite left behind, and adopting it is how the
// operator gets their driver back. Adoption is only safe for an account
// NOBODY has ever used, and the product's sessions are stateless tokens whose
// role is read from the database on every request: adopting an account that
// holds a live session would hand that session this tenant's driver portal,
// and replacing the password would not end it.
//
// So the product needs a marker — a fact on the account that says "a session
// has existed here" — and three properties of it are load-bearing:
//
//   1. IT IS WRITTEN WHERE EVERY SESSION IS MADE. There are three ways in:
//      the password sign-in, the phone code and the first-run setup. Only the
//      password sign-in can be told apart from the others by looking at the
//      credential, because a credential cannot tell use from disuse — the
//      credential a failed invite leaves behind is one nobody knows, and it
//      looks exactly like a used one. So the marker is a SESSION, and it is
//      written at the one place a session is minted. An account that had a
//      session through the phone code has been used, and must be refused.
//
//   2. THE DECISION AND THE WRITE CANNOT DISAGREE. A sign-in verifies a
//      password (PBKDF2 at 600,000 iterations — slow enough that the world
//      moves while it runs) and then writes the marker. An adoption reads the
//      marker and then replaces the password. If those are two reads and two
//      writes with nothing between them, a sign-in can slip through the gap:
//      the adoption sees "never used", replaces the password, and gives the
//      membership — and the sign-in, which verified the OLD password, goes on
//      to mint a session for an account whose password had just changed. So
//      both take the account's rows under a lock, in a fixed order, and the
//      marker and the credential are read and written as one decision.
//
//   3. NOBODY CAN REACH THE MARKER. It is a security fact about the account,
//      so a user who can write it can decide whether their own account is
//      adoptable — and an account they can adopt is an account they can take
//      over. The marker lives in `auth.users.raw_user_meta_data`, which is in
//      the `auth` schema: PostgREST serves only `public`, and no request
//      role holds any privilege on those tables. This file asserts that
//      against the real database, so the property is CHECKED rather than
//      ASSUMED — a later migration that grants `authenticated` a SELECT on
//      `auth.users` would silently reopen the hole, and this file would say so.
//
// It needs a database AND the application, because the invite goes through
// PostgREST:
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//   APP_ORIGIN=http://127.0.0.1:55431 \
//   JWT_SHARED_SECRET=... pnpm test
//
// The two race tests take the account's row lock from a connection of their
// own and watch `pg_locks` for the waiter — the same technique the period
// close uses to prove a bank line cannot land in the middle of a close.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { localDb } from '@/lib/db/local';
import {
  AccountNotAdoptableError,
  adoptUnusedAccount,
  setLocalPassword,
  signInWithPassword,
} from '@/lib/auth/local-store';
import { issueSessionToken } from '@/lib/auth/local-session';
import { accountHasHadASession, SESSION_ISSUED_KEY } from '@/lib/auth/account-usage';
import { hashPassword } from '@/lib/auth/password';
import { inviteDriver } from '@/lib/ops/driver-invite';
import { deploymentProfile } from '@/lib/deployment/profile';
import { integrationEnv } from '../../helpers/integration-env';

const env = integrationEnv();

/** The profile the file leaves behind, so it does not leak into the next file. */
const PREVIOUS_PROFILE = process.env.DEPLOYMENT_PROFILE;
/** The signing secret the file leaves behind, if it had to set one. */
const PREVIOUS_SECRET = process.env.JWT_SHARED_SECRET;
const PREVIOUS_LOCAL_SECRET = process.env.LOCAL_JWT_SECRET;

/** Wait for a condition, up to a deadline. Returns whether it happened. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * How many backends are blocked on the `auth.users` row for this account.
 *
 * A waiter shows up in one of two shapes, and both are blocked:
 *
 *   * the FIRST to arrive holds the tuple lock and waits for the holder's
 *     transaction to finish — an ungranted `transactionid` lock;
 *
 *   * the ones BEHIND it are queued on the tuple lock itself, which the one
 *     in front holds — an ungranted `tuple` lock.
 *
 * So a query that only looks for the first shape sees one waiter however many
 * are actually queued. This counts both, and it counts only waiters on THIS
 * table — the query is specific enough to be evidence rather than a guess.
 */
async function waitersOnAccount(observer: Sql): Promise<number> {
  const rows = (await observer`
    select count(distinct pid)::int as waiting
      from (
        select l.pid
          from pg_locks l
          join pg_class c on c.oid = l.relation
         where l.locktype = 'tuple'
           and not l.granted
           and c.relname = 'users'
           and c.relnamespace = (select oid from pg_namespace where nspname = 'auth')
        union
        select l.pid
          from pg_locks l
         where l.locktype = 'transactionid'
           and not l.granted
           and exists (
             select 1
               from pg_locks t
               join pg_class c on c.oid = t.relation
              where t.pid = l.pid
                and t.locktype = 'tuple'
                and c.relname = 'users'
                and c.relnamespace = (select oid from pg_namespace where nspname = 'auth')
           )
      ) as blocked
  `) as Array<{ waiting: number }>;
  return rows[0]?.waiting ?? 0;
}

describe.skipIf(!env)('the account marker, on a self-hosted deployment', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const slug = `marker-${tenantId.slice(0, 8)}`;

  /** Accounts this file made, so the cleanup can find them. */
  const madeUsers: string[] = [];

  beforeAll(async () => {
    // The deployment under test — the local credential store, not Supabase.
    process.env.DEPLOYMENT_PROFILE = 'hosted';

    // A session cannot be minted without the signing secret. The hosted
    // deployment always has one; a developer running this file on its own may
    // not, so the file supplies a throwaway rather than refusing to run.
    if (!process.env.LOCAL_JWT_SECRET && !process.env.JWT_SHARED_SECRET) {
      process.env.JWT_SHARED_SECRET = 'marker-test-secret-not-a-real-one';
    }

    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Account marker test', ${slug})
    `;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${ownerId}::uuid, ${`owner-${slug}@brownhill.test`}, '{"role":"ops"}'::jsonb)
    `;
    await sql`
      insert into public.tenant_memberships (tenant_id, user_id, role, status)
      values (${tenantId}::uuid, ${ownerId}::uuid, 'owner', 'active')
    `;
  });

  afterAll(async () => {
    if (PREVIOUS_PROFILE === undefined) delete process.env.DEPLOYMENT_PROFILE;
    else process.env.DEPLOYMENT_PROFILE = PREVIOUS_PROFILE;
    if (PREVIOUS_SECRET === undefined) delete process.env.JWT_SHARED_SECRET;
    else process.env.JWT_SHARED_SECRET = PREVIOUS_SECRET;
    if (PREVIOUS_LOCAL_SECRET === undefined) delete process.env.LOCAL_JWT_SECRET;
    else process.env.LOCAL_JWT_SECRET = PREVIOUS_LOCAL_SECRET;

    // The public audit log is append-only, and its rows reference the tenant
    // and the actor — so the trigger is lifted for the length of this cleanup
    // and put straight back.
    await sql`alter table public.audit_log disable trigger trg_audit_immutable`;
    try {
      await sql`delete from public.audit_log where tenant_id = ${tenantId}::uuid`;
      await sql`delete from public.tenant_memberships where tenant_id = ${tenantId}::uuid`;
      await sql`delete from public.drivers where tenant_id = ${tenantId}::uuid`;
      await sql`
        delete from auth.local_credentials where user_id in (
          select id from auth.users where email like ${`%${slug}%`}
        )
      `;
      await sql`delete from auth.users where email like ${`%${slug}%`}`;
      await sql`delete from public.tenants where id = ${tenantId}::uuid`;
    } finally {
      await sql`alter table public.audit_log enable trigger trg_audit_immutable`;
    }
  });

  /** Make an account with a credential nobody has signed in with. */
  async function makeAccount(tag: string): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `${tag}-${slug}@brownhill.test`;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${id}::uuid, ${email}, '{"role":"driver"}'::jsonb)
    `;
    madeUsers.push(id);
    return { id, email };
  }

  it('runs on a deployment with no account provider behind it', () => {
    expect(deploymentProfile().supabaseAuth).toBe(false);
  });

  // ── 1. the marker is written wherever a session is made ─────────────────

  it('records that a session exists, even when no password was ever used', async () => {
    const { id, email } = await makeAccount('otp');

    // Nobody has signed in. The account looks exactly like the one a failed
    // invite leaves behind.
    expect(await accountHasHadASession(id)).toBe(false);

    // A session is minted the way the phone-code path and the first-run
    // setup path mint one: with no password involved at all.
    const token = await issueSessionToken({ id, email }, null);
    expect(token.split('.')).toHaveLength(3);

    // Now it has been used.
    expect(await accountHasHadASession(id)).toBe(true);
  });

  it('writes the marker under a key nobody else writes', async () => {
    const { id, email } = await makeAccount('keyed');
    await issueSessionToken({ id, email }, null);

    // The marker is a key in the account's metadata, and the key is a
    // literal in the code — never anything a user supplied. If a user could
    // choose the key, they could clear the marker by writing a different
    // value under it, and the account would look unused again.
    const rows = (await sql`
      select raw_user_meta_data ? ${SESSION_ISSUED_KEY} as has_key,
             raw_user_meta_data ->> 'role' as role
        from auth.users where id = ${id}::uuid
    `) as Array<{ has_key: boolean; role: string | null }>;

    expect(rows[0].has_key).toBe(true);
    // The metadata the account was created with is still there — the marker
    // is added to it, not over it.
    expect(rows[0].role).toBe('driver');
  });

  it('refuses to take over an account whose only session came from a phone code', async () => {
    // The gap this closes. The marker used to be written by the password
    // sign-in only, so an account that had been in to through the phone code
    // — or through the first-run setup — carried no marker at all. The
    // invite looked at that marker, saw "never used", and adopted the
    // account: it linked the profile, gave it a membership in this tenant and
    // handed the operator a password. The person who had been using the
    // account kept their live session, and that session now resolved to this
    // tenant's driver portal.
    const { id, email } = await makeAccount('taken');
    const theirPassword = 'the-password-they-already-know';
    await setLocalPassword(id, theirPassword);

    // A session, minted without a password.
    await issueSessionToken({ id, email }, null);

    await expect(
      inviteDriver({ tenantId, email, newDriver: { full_name: 'Taken Account' } }),
    ).rejects.toThrow(/already has an account that has been used/i);

    // The credential is untouched: the password they know still signs in.
    const signin = await signInWithPassword(email, theirPassword);
    expect(signin.ok).toBe(true);

    // And the account was not linked into this tenant, so the session it
    // still holds grants nothing here.
    const memberships = (await sql`
      select 1 from public.tenant_memberships where user_id = ${id}::uuid
    `) as unknown as unknown[];
    expect(memberships).toHaveLength(0);

    const profiles = (await sql`
      select driver_id from public.profiles where id = ${id}::uuid
    `) as Array<{ driver_id: string | null }>;
    expect(profiles[0]?.driver_id ?? null).toBeNull();
  });

  // ── 2. the decision and the write cannot disagree ──────────────────────

  it('does not sign in with a password that changed while the sign-in was verifying it', async () => {
    // PBKDF2 at 600,000 iterations takes long enough that the world moves
    // while it runs. If the credential can be replaced in that window, a
    // sign-in that verified the OLD password would go on to mint a session
    // for an account whose password had just been replaced — and the
    // adoption that replaced it is exactly the flow that must not be
    // raced.
    //
    // So the sign-in re-reads the credential under the account's lock and
    // re-checks the password against whatever is there now. This test holds
    // the lock, changes the password under it, and proves the sign-in does
    // not come back with a session.
    const { id, email } = await makeAccount('raced');
    const oldPassword = 'the-password-they-knew';
    const newPassword = 'the-password-it-became';

    await setLocalPassword(id, oldPassword);

    // The new hash is computed BEFORE the lock is taken: a transaction must
    // never be held open across a key derivation.
    const newHash = await hashPassword(newPassword);

    const { default: postgres } = await import('postgres');
    // The holder runs on its OWN connection, so the application's pool stays
    // free for the sign-in under test.
    const holder = postgres(env!.DATABASE_URL, { max: 1 });
    const observer = postgres(env!.DATABASE_URL, { max: 1 });

    let releaseHolder: () => void = () => {};
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let signalLocked: () => void = () => {};
    const holderLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const holding = holder.begin(async (tx) => {
      await tx`select id from auth.users where id = ${id}::uuid for update`;
      await tx`
        update auth.local_credentials
        set password_hash = ${newHash}, updated_at = now()
        where user_id = ${id}::uuid
      `;
      signalLocked();
      await holderReleased;
    });
    await holderLocked;

    try {
      // The sign-in starts while the account is locked. It reads the
      // credential (the OLD hash — the holder has not committed), verifies
      // the old password against it, and then blocks on the lock.
      const signin = signInWithPassword(email, oldPassword);

      // Is it actually blocked on the account's row lock? `pg_locks` says
      // so precisely.
      const blocked = await waitFor(async () => (await waitersOnAccount(observer)) > 0);
      expect(blocked, 'the sign-in never blocked on the account lock').toBe(true);

      // Let the change land.
      releaseHolder();
      await holding;

      const result = await signin;
      expect(result.ok).toBe(false);

      // The password it became is the one that works now.
      const after = await signInWithPassword(email, newPassword);
      expect(after.ok).toBe(true);
    } finally {
      releaseHolder();
      await holding.catch(() => {});
      await holder.end({ timeout: 5 });
      await observer.end({ timeout: 5 });
    }
  });

  it('never lets an adoption and a sign-in both succeed', async () => {
    // The two operations that must not interleave, racing on the same
    // account: a sign-in (which verifies a password and marks the account as
    // used) and an adoption (which reads that mark and replaces the
    // password).
    //
    // Whichever takes the account's lock first wins, and the other must
    // fail. The outcomes are different and both are correct:
    //
    //   * the sign-in wins — the account is now marked as used, so the
    //     adoption is refused, and the password is untouched;
    //
    //   * the adoption wins — the password is replaced, so the sign-in that
    //     verified the OLD password must fail.
    const { id, email } = await makeAccount('both');
    const theirPassword = 'the-password-they-knew';
    const adoptedPassword = 'the-password-the-operator-was-given';

    await setLocalPassword(id, theirPassword);

    const { default: postgres } = await import('postgres');
    const holder = postgres(env!.DATABASE_URL, { max: 1 });
    const observer = postgres(env!.DATABASE_URL, { max: 1 });

    let releaseHolder: () => void = () => {};
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let signalLocked: () => void = () => {};
    const holderLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const holding = holder.begin(async (tx) => {
      await tx`select id from auth.users where id = ${id}::uuid for update`;
      signalLocked();
      await holderReleased;
    });
    await holderLocked;

    try {
      // Both start while the account is locked, so both queue on the same
      // lock. The sign-in is started first, so it is the one that gets the
      // account when the lock is released.
      const signin = signInWithPassword(email, theirPassword);
      const adoption = adoptUnusedAccount(id, tenantId, adoptedPassword).then(
        () => 'adopted' as const,
        (error: unknown) => {
          if (error instanceof AccountNotAdoptableError) return 'refused' as const;
          throw error;
        },
      );

      // Wait until BOTH are queued on the lock — otherwise this would prove
      // nothing about the race, only about the order they happened to run in.
      const bothWaiting = await waitFor(async () => (await waitersOnAccount(observer)) >= 2);
      expect(bothWaiting, 'the adoption and the sign-in did not both reach the lock').toBe(true);

      releaseHolder();
      await holding;

      const signinResult = await signin;
      const adoptionResult = await adoption;

      const signedIn = signinResult.ok;
      const adopted = adoptionResult === 'adopted';

      // Exactly one of them won. Never both, never neither.
      expect(signedIn && adopted, 'a sign-in and an adoption both succeeded').toBe(false);
      expect(!signedIn && !adopted, 'neither the sign-in nor the adoption succeeded').toBe(false);

      if (signedIn) {
        // The sign-in won: the account is marked as used, so the adoption is
        // refused and the credential is untouched.
        expect(adoptionResult).toBe('refused');
        expect(await accountHasHadASession(id)).toBe(true);
        const stillTheirs = await signInWithPassword(email, theirPassword);
        expect(stillTheirs.ok).toBe(true);
      } else {
        // The adoption won: the password it wrote is the one that works, and
        // the old one no longer does.
        expect(adoptionResult).toBe('adopted');
        const old = await signInWithPassword(email, theirPassword);
        expect(old.ok).toBe(false);
        const fresh = await signInWithPassword(email, adoptedPassword);
        expect(fresh.ok).toBe(true);
      }
    } finally {
      releaseHolder();
      await holding.catch(() => {});
      await holder.end({ timeout: 5 });
      await observer.end({ timeout: 5 });
    }
  });

  // ── 3. nobody can reach the marker ─────────────────────────────────────

  it('keeps the account tables out of reach of every request role', async () => {
    // The marker is a security fact, and it lives in `auth.users`. If any
    // request role could read that table it could read the marker — and if
    // any role could WRITE it, it could clear the marker and make an
    // account look unused, which is the takeover this whole design refuses.
    //
    // The check is against the real database, so a migration that grants
    // `authenticated` a SELECT on `auth.users` is caught here rather than in
    // production.
    //
    // FIRST the control: the same query, pointed at a table that IS granted.
    // `public.tenants` is served to `authenticated`, so the query returns
    // rows. Without this, an empty result would only prove that the query
    // finds nothing — not that it would find something if there were
    // something to find.
    const control = (await sql`
      select grantee, table_name, privilege_type
        from information_schema.table_privileges
       where table_schema = 'public'
         and table_name = 'tenants'
         and grantee <> 'postgres'
    `) as Array<{ grantee: string; table_name: string; privilege_type: string }>;
    expect(
      control.length,
      'the control table has no grants, so the check below proves nothing',
    ).toBeGreaterThan(0);

    const grants = (await sql`
      select grantee, table_name, privilege_type
        from information_schema.table_privileges
       where table_schema = 'auth'
         and table_name in ('users', 'local_credentials')
         and grantee <> 'postgres'
    `) as Array<{ grantee: string; table_name: string; privilege_type: string }>;

    expect(
      grants,
      'a role other than the owner holds a privilege on an auth table',
    ).toEqual([]);

    // And the three roles the deployment creates are each checked by name,
    // because a role that does not exist yet cannot hold a privilege and
    // `has_table_privilege` throws on a role that is not there.
    const roles = (await sql`
      select rolname from pg_roles
       where rolname in ('anon', 'authenticated', 'service_role')
    `) as Array<{ rolname: string }>;

    expect(roles.map((r) => r.rolname).sort()).toEqual([
      'anon',
      'authenticated',
      'service_role',
    ]);

    for (const { rolname } of roles) {
      const held = (await sql`
        select has_table_privilege(${rolname}, 'auth.users', 'SELECT') as read_users,
               has_table_privilege(${rolname}, 'auth.users', 'INSERT') as write_users,
               has_table_privilege(${rolname}, 'auth.users', 'UPDATE') as update_users,
               has_table_privilege(${rolname}, 'auth.users', 'DELETE') as delete_users,
               has_table_privilege(${rolname}, 'auth.local_credentials', 'SELECT') as read_credentials
      `) as Array<{
        read_users: boolean;
        write_users: boolean;
        update_users: boolean;
        delete_users: boolean;
        read_credentials: boolean;
      }>;

      expect(held[0], `${rolname} holds a privilege on an auth table`).toEqual({
        read_users: false,
        write_users: false,
        update_users: false,
        delete_users: false,
        read_credentials: false,
      });
    }
  });
});
