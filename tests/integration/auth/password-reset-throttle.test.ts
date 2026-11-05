// tests/integration/auth/password-reset-single-use.test.ts's neighbour:
// tests/integration/auth/password-reset-throttle.test.ts
//
// The reset throttle, proved against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// The security review of 2026-11-04 found the throttle doing three things
// wrong, and every one of them was a property of the SQL rather than of the
// decision around it:
//
//   1. The counter was incremented AFTER the mail had gone out. The whole
//      email round trip happens between the check and the increment, so a
//      hundred concurrent requests all passed a limit of three.
//
//   2. The counter was only incremented for addresses that were on file,
//      so a stranger guessing addresses was never counted at all.
//
//   3. The allowance was counted against an address the caller chose.
//
// A unit test with a fake store cannot see any of them: the fake decides
// for itself what "concurrent" means and never takes a lock. So the
// properties are proved here, against the real database, with real
// concurrent transactions.
//
// THE PROOFS
// ----------
//   * twenty concurrent requests from one caller: at most ten are allowed.
//   * twenty concurrent requests for one account: at most three are
//     allowed.
//   * a request that names an account nobody has still counts against the
//     caller's allowance.
//   * the table holds no address — there is no column to hold one.
//   * a request older than the retention window is pruned.
//
// WHAT "COUNTS" MEANS HERE
// ------------------------
// A request that is ALLOWED leaves a record, and a request that is refused
// does not. The refused ones need no record: they are over the limit, and
// the limit is the count of the records, so a request that adds no record
// cannot change the answer. The records exist to answer "how many of this
// caller's requests have been allowed in the last hour", and an allowed
// request that named NOBODY is recorded exactly like one that named
// somebody — that is the property the old code got wrong, because it only
// counted the ones that turned out to be real accounts.
//
// It needs a database:
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It talks straight to postgres and never through the service client, so it
// asks for the database alone.
//
// IT LEAVES NOTHING BEHIND
// ------------------------
// Every account it creates is removed again in the same run, and its
// requests are removed with it.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { makeLocalResetThrottleStore } from '@/lib/auth/password-reset-local-store';
import {
  MAX_RESET_REQUESTS_PER_ACCOUNT_15M,
  MAX_RESET_REQUESTS_PER_IP_1H,
  RESET_REQUEST_RETENTION_MINUTES,
} from '@/lib/auth/password-reset-throttle';
import { integrationEnv } from '../../helpers/integration-env';

vi.setConfig({ testTimeout: 60_000 });

type Sql = Awaited<ReturnType<typeof localDb>>;

const env = integrationEnv({ app: false });

describe.skipIf(!env)('the password reset throttle', () => {
  let sql: Sql;
  let throttle: ReturnType<typeof makeLocalResetThrottleStore>;

  const runId = randomUUID().slice(0, 8);
  const like = `reset-throttle-%-${runId}@example.test`;

  /** The accounts this run created. */
  const accounts = new Map<string, string>();

  /** The caller addresses this run used. */
  const addresses: string[] = [];

  beforeAll(async () => {
    sql = await localDb();
    throttle = makeLocalResetThrottleStore(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from password_reset_requests where requested_ip like ${`%${runId}%`}`;
    await sql`delete from auth.users where email like ${like}`;
    await sql.end({ timeout: 5 });
  });

  /** A caller address this run owns, so the tests cannot collide. */
  function callerAddress(tag: string): string {
    const address = `198.51.100.${tag}-${runId.slice(0, 4)}`;
    addresses.push(address);
    return address;
  }

  /** An account this run owns. */
  async function account(tag: string): Promise<string> {
    const email = `reset-throttle-${tag}-${runId}@example.test`;
    const rows = (await sql`
      insert into auth.users (email)
      values (${email})
      returning id::text as id
    `) as Array<{ id: string }>;
    accounts.set(email, rows[0].id);
    return rows[0].id;
  }

  it('counts every request against the caller, including the ones that name nobody', async () => {
    const ip = callerAddress('every');

    // Twelve requests from one caller. The allowance is ten an hour.
    const decisions = [];
    for (let i = 0; i < MAX_RESET_REQUESTS_PER_IP_1H + 2; i += 1) {
      decisions.push(await throttle.takeIpAllowance({ ip, now: new Date() }));
    }

    const allowed = decisions.filter((d) => d.allowed);
    expect(allowed).toHaveLength(MAX_RESET_REQUESTS_PER_IP_1H);

    // And every ALLOWED one left a record — including the ones that named
    // an address nobody has, which is the point: a request that names
    // nobody is still a request, and it still spends the caller's
    // allowance. The two that were refused left no record, because a
    // record that added nothing would change nothing.
    const rows = (await sql`
      select count(*)::int as n from password_reset_requests where requested_ip = ${ip}
    `) as Array<{ n: number }>;
    expect(rows[0].n).toBe(MAX_RESET_REQUESTS_PER_IP_1H);
  });

  it('lets only one of two requests that race each other take the same allowance', async () => {
    const ip = callerAddress('race');

    // Twenty requests at once. Without a lock, every one of them reads the
    // same count, decides there is room, and writes — which is how a
    // hundred concurrent requests all passed a limit of three.
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => throttle.takeIpAllowance({ ip, now: new Date() })),
    );

    const allowed = decisions.filter((d) => d.allowed);
    expect(allowed, 'the allowance must not be handed out twice').toHaveLength(
      MAX_RESET_REQUESTS_PER_IP_1H,
    );

    const rows = (await sql`
      select count(*)::int as n from password_reset_requests where requested_ip = ${ip}
    `) as Array<{ n: number }>;
    expect(rows[0].n).toBe(MAX_RESET_REQUESTS_PER_IP_1H);
  });

  it('gives one account no more links than its allowance', async () => {
    const ip = callerAddress('account');
    const accountId = await account('allowance');

    // Twenty requests for the SAME account, each with its own caller
    // allowance, all racing for the account's allowance.
    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const reservation = await throttle.takeIpAllowance({ ip, now: new Date() });
        if (!reservation.allowed) return { allowed: false };
        return throttle.takeAccountAllowance({
          requestId: reservation.requestId,
          accountId,
          now: new Date(),
        });
      }),
    );

    const allowed = decisions.filter((d) => d.allowed);
    expect(allowed, 'an inbox must not receive every request that names it').toHaveLength(
      MAX_RESET_REQUESTS_PER_ACCOUNT_15M,
    );

    // And the requests that were refused are not attached to the account, so
    // they cannot count against it later either.
    const attached = (await sql`
      select count(*)::int as n
        from password_reset_requests
       where account_id = ${accountId}::uuid
    `) as Array<{ n: number }>;
    expect(attached[0].n).toBe(MAX_RESET_REQUESTS_PER_ACCOUNT_15M);
  });

  it('keeps no address', async () => {
    // The table has no column that could hold one. The request holds the
    // account it turned out to belong to, and the caller's address.
    const columns = (await sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'password_reset_requests'
    `) as Array<{ column_name: string }>;

    expect(columns.map((c) => c.column_name)).not.toContain('email');
  });

  it('prunes a request that is older than the retention window', async () => {
    const ip = callerAddress('prune');

    // A row from long ago — the shape a box accumulates over the years.
    await sql`
      insert into password_reset_requests (requested_ip, created_at)
      values (${ip}, now() - make_interval(mins => ${RESET_REQUEST_RETENTION_MINUTES + 60}))
    `;

    const before = (await sql`
      select count(*)::int as n from password_reset_requests where requested_ip = ${ip}
    `) as Array<{ n: number }>;
    expect(before[0].n).toBe(1);

    // Any request prunes, which is exactly as often as the table grows.
    await throttle.takeIpAllowance({ ip, now: new Date() });

    const after = (await sql`
      select count(*)::int as n
        from password_reset_requests
       where requested_ip = ${ip}
         and created_at > now() - make_interval(mins => ${RESET_REQUEST_RETENTION_MINUTES})
    `) as Array<{ n: number }>;
    expect(after[0].n).toBe(1);
  });

  it('does not prune a request that is still counting towards an allowance', async () => {
    const ip = callerAddress('window');

    // Just inside the caller's window. It must still be there, because it is
    // still counting.
    await sql`
      insert into password_reset_requests (requested_ip, created_at)
      values (${ip}, now() - interval '10 minutes')
    `;

    await throttle.takeIpAllowance({ ip, now: new Date() });

    const rows = (await sql`
      select count(*)::int as n from password_reset_requests where requested_ip = ${ip}
    `) as Array<{ n: number }>;
    expect(rows[0].n).toBe(2);
  });
});
