// tests/integration/auth/otp-address.test.ts
//
// Which address a one-time sign-in code is counted against.
//
// WHY THIS FILE EXISTS
// --------------------
// The one-time code endpoint throttles per phone AND per address:
//
//     MAX_CODES_PER_PHONE_15M = 3
//     MAX_CODES_PER_IP_1H     = 10
//
// The per-address half of that was a counter the CALLER controlled. The
// route read the address like this:
//
//     request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
//
// and that is the FIRST element of the list — which is the element the caller
// supplied.
//
// What nginx sends is the opposite. `proxy_set_header X-Forwarded-For
// $proxy_add_x_forwarded_for` APPENDS: whatever the caller sent is kept, and
// the address nginx actually saw is added to the END. So the header arrives
// as:
//
//     1.2.3.4, 5.6.7.8, <the address nginx saw>
//     ^^^^^^^^  ^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^
//     the        the        the truth
//     caller's   caller's
//
// Reading the first element meant the limit counted addresses the caller
// chose. A caller who sent a different one on every request walked straight
// past ten codes an hour — the limit was a counter with a reset button.
//
// The same defect was in three other places: the signing route (the signer's
// address in the audit), the legal acceptance action (the address in the
// legal trail), and — this file is about the fourth — the one-time code
// route itself.
//
// WHAT IS PROVED HERE
// -------------------
// The route counts the address nginx saw, and a caller who rotates their
// own claim is still counted against the one address.
//
// This is an integration test because the thing being proved is a LIMIT, and
// a limit is only a limit if the store that holds it is the real one. A unit
// test with a fake store would have agreed with the broken code — which is
// exactly what happened to the password reset, whose unit suite passed while
// the production SQL was wrong.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It talks straight to postgres and never through the service client, so it
// asks for the database alone.
//
// IT LEAVES NOTHING BEHIND
// ------------------------
// The codes it asks for are removed in the same run. The phone numbers are
// derived from this run's own id, so a run that is killed before its
// cleanup leaves rows that the next run's numbers cannot collide with.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { integrationEnv } from '../../helpers/integration-env';
import { POST } from '@/app/api/auth/local/otp/request/route';

type Sql = Awaited<ReturnType<typeof localDb>>;

// The one-time code store is a direct postgres connection.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('the address a one-time code is counted against', () => {
  let sql: Sql;

  // Derived from this run's id, so a killed run's leftovers are inert.
  const runId = randomUUID().slice(0, 8);
  const runDigits = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);

  /**
   * The address nginx saw, for one test.
   *
   * Each test gets its own: they are separate cases of the same limit, and a
   * case that inherits the previous case's codes is testing the wrong thing.
   * The numbers come out of the documentation ranges, so they can never be a
   * real host, and they are varied per run so a leftover row from an earlier
   * run cannot be counted into this one's limit.
   */
  const seenFor = (n: number) =>
    `198.51.100.${((parseInt(runId.slice(0, 2), 16) + n) % 250) + 1}`;

  /** The address the caller CLAIMS. It changes on every request. */
  const claimedAddress = (i: number) => `203.0.113.${(i % 250) + 1}`;

  /** A phone number of this run's own, so the phone limit never interferes. */
  const phoneFor = (i: number) => `+4477${runDigits}${String(i).padStart(2, '0')}`;

  beforeAll(async () => {
    sql = await localDb();

    // The one-time code route is for the local-auth builds. The SaaS build
    // answers 404, because its identity comes from Supabase Auth.
    process.env.DEPLOYMENT_PROFILE = 'standalone';

    // Any row an earlier run left against these addresses would be counted
    // into this run's limits and make the tests fail for the wrong reason.
    for (let n = 1; n <= 3; n++) {
      await sql`delete from login_codes where requested_ip = ${seenFor(n)}`;
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from login_codes where phone like ${`+4477${runDigits}%`}`;
    await sql.end({ timeout: 5 });
  });

  /**
   * Ask for a code, the way a browser behind nginx would.
   *
   * The header is `claim, seen` — the caller's own address first, the one
   * nginx saw last, which is the shape nginx actually produces.
   */
  async function requestCode(index: number, seen: string, claim = claimedAddress(index)) {
    const response = await POST(
      new Request('https://fleet.example.com/api/auth/local/otp/request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `${claim}, ${seen}`,
        },
        body: JSON.stringify({ phone: phoneFor(index) }),
      }),
    );
    return response.status;
  }

  /** The address the code was actually recorded against. */
  async function recordedAddress(index: number): Promise<string | null> {
    const rows = (await sql`
      select requested_ip from login_codes where phone = ${phoneFor(index)}
    `) as Array<{ requested_ip: string | null }>;
    return rows[0]?.requested_ip ?? null;
  }

  it('records the address nginx saw, not the one the caller claimed', async () => {
    const seen = seenFor(1);
    const status = await requestCode(1, seen);
    expect(status).toBe(200);

    // The claim was 203.0.113.2 and the truth was the second element.
    expect(await recordedAddress(1)).toBe(seen);
  });

  it('counts a caller who rotates their own claim against one address', async () => {
    const seen = seenFor(2);

    // Ten codes an hour, per address. Every one of these requests claims a
    // DIFFERENT address and is really from the same one, so a limit counted
    // against the claim would never be reached.
    for (let i = 0; i < 10; i++) {
      const status = await requestCode(10 + i, seen);
      expect(status, `request ${i + 1} of 10 should be allowed`).toBe(200);
    }

    // The eleventh, from the same address, is refused.
    const eleventh = await requestCode(20, seen);
    expect(eleventh).toBe(429);
  });

  it('lets a different address through', async () => {
    // The limit is per address, so an address that has not asked for ten
    // codes an hour is not refused — otherwise one busy office would lock
    // out everybody behind it.
    const response = await POST(
      new Request('https://fleet.example.com/api/auth/local/otp/request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '192.0.2.77',
        },
        body: JSON.stringify({ phone: phoneFor(30) }),
      }),
    );
    expect(response.status).toBe(200);
    await sql`delete from login_codes where phone = ${phoneFor(30)}`;
  });
});
