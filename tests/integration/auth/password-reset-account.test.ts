// tests/integration/auth/password-reset-account.test.ts
//
// The account, read at the moment of redemption — proved against a real database.
//
// WHY THIS FILE EXISTS
// --------------------
// The redemption reads the account's CURRENT role and CURRENT tenants, because
// the link in the email can be half an hour old and the role can have changed
// in that time. The unit suite checks the SQL's TEXT; this file runs the real
// store against a real postgres and asks the only question that matters: does
// the read hand back the role the account holds, and the tenants it actually
// belongs to?
//
// The one thing a text check cannot see is the JOIN. `tenant_memberships`
// hangs off `profiles`, not off `auth.users`, and a membership that is
// DISABLED is not a tenant the password opens — so it must not be in the
// list the audit row is filed under. A membership that is not active and a
// membership that is active differ in one word of SQL, and the difference is
// the difference between an audit row filed in the right tenant and one
// filed in the wrong one.
//
// It needs a database:
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It talks straight to postgres and never through the service client, so it
// asks for the database alone.
//
// IT LEAVES NOTHING BEHIND
// ------------------------
// Every row it creates is removed again in the same run, and the slugs and
// addresses are derived from this run's own id, so a run killed before its
// cleanup leaves rows the next run cannot collide with.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { makeLocalResetTokenStore } from '@/lib/auth/password-reset-local-store';
import { integrationEnv } from '../../helpers/integration-env';

type Sql = Awaited<ReturnType<typeof localDb>>;

// The reset store lives behind the direct connection. No application origin
// needed.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('the account, read at the redemption', () => {
  let sql: Sql;
  let store: ReturnType<typeof makeLocalResetTokenStore>;

  // Derived from this run's id, so a killed run's leftovers are inert.
  const runId = randomUUID().slice(0, 8);
  const like = `reset-account-%-${runId}@example.test`;
  const slugLike = `reset-account-${runId}`;

  /** The account with a profile, a role, and memberships in both tenants. */
  const WITH_PROFILE = `reset-account-with-profile-${runId}@example.test`;
  /** The account with nothing at all but an address. */
  const WITHOUT_PROFILE = `reset-account-without-profile-${runId}@example.test`;

  /** The tenant whose membership is active, and the one whose is not. */
  const ACTIVE_TENANT = randomUUID();
  const DISABLED_TENANT = randomUUID();

  const accounts = new Map<string, string>();

  beforeAll(async () => {
    sql = await localDb();
    store = makeLocalResetTokenStore(sql);

    for (const [id, name] of [
      [ACTIVE_TENANT, 'Active'],
      [DISABLED_TENANT, 'Disabled'],
    ]) {
      await sql`
        insert into tenants (id, name, slug)
        values (${id}::uuid, ${name}, ${`${slugLike}-${id.slice(-4)}`})
      `;
    }

    for (const email of [WITH_PROFILE, WITHOUT_PROFILE]) {
      const users = (await sql`
        insert into auth.users (email)
        values (${email})
        returning id
      `) as Array<{ id: string }>;
      accounts.set(email, users[0].id);
    }

    // Inserting into `auth.users` fires a trigger that provisions a profile
    // row, so the profile is already there — with the default role. The
    // account's role is then set to something that is NOT the default, so
    // the read has to be READ to produce it.
    const withProfile = accounts.get(WITH_PROFILE)!;
    await sql`update profiles set role = 'ops' where id = ${withProfile}::uuid`;
    await sql`
      insert into tenant_memberships (tenant_id, user_id, role, status)
      values
        (${ACTIVE_TENANT}::uuid, ${withProfile}::uuid, 'driver', 'active'),
        (${DISABLED_TENANT}::uuid, ${withProfile}::uuid, 'driver', 'disabled')
    `;

    // The account with nothing: its profile row is removed, so it has no
    // role and no membership — a membership cannot exist without a profile,
    // because the membership's user hangs off the profile.
    const withoutProfile = accounts.get(WITHOUT_PROFILE)!;
    await sql`delete from profiles where id = ${withoutProfile}::uuid`;
    await sql`
      insert into auth.local_credentials (user_id, password_hash)
      values (
        ${withoutProfile}::uuid,
        'not-a-real-hash-this-row-is-never-verified'
      )
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`
      delete from tenant_memberships
       where user_id in (select id from auth.users where email like ${like})
    `;
    await sql`delete from profiles where id in (select id from auth.users where email like ${like})`;
    await sql`
      delete from auth.local_credentials
       where user_id in (select id from auth.users where email like ${like})
    `;
    await sql`delete from auth.users where email like ${like}`;
    await sql`delete from tenants where slug like ${`${slugLike}%`}`;
    await sql.end({ timeout: 5 });
  });

  it('reads the role the account holds', async () => {
    const userId = accounts.get(WITH_PROFILE)!;

    const account = await store.currentAccount(userId);

    expect(account.role).toBe('ops');
  });

  it('reads the tenants the account belongs to, and only the active ones', async () => {
    const userId = accounts.get(WITH_PROFILE)!;

    const account = await store.currentAccount(userId);

    expect(account.tenantIds).toEqual([ACTIVE_TENANT]);
    // The disabled membership is not a tenant the password opens, so it is
    // not a tenant the audit row may be filed under.
    expect(account.tenantIds).not.toContain(DISABLED_TENANT);
  });

  it('reports an account with no profile as having no role and no tenant', async () => {
    // Not an error: there are accounts with an address and a credential and
    // nothing else. The staff door is the door they belong at, and the audit
    // row has nowhere to go — which the caller reports loudly.
    const userId = accounts.get(WITHOUT_PROFILE)!;

    const account = await store.currentAccount(userId);

    expect(account).toEqual({ role: '', tenantIds: [] });
  });

  it('fails when the account does not exist', async () => {
    // A read that cannot answer has to fail, so the redemption refuses
    // rather than guessing a role and a tenant.
    await expect(
      store.currentAccount('99999999-9999-9999-9999-999999999999'),
    ).rejects.toThrow();
  });
});
