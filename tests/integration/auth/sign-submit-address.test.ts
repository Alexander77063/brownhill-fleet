// tests/integration/auth/sign-submit-address.test.ts
//
// The address the signing trail records.
//
// WHY THIS FILE EXISTS
// --------------------
// When a driver signs, the product records WHERE they signed from: the
// `signing_sessions.signer_ip` column, and the audit row beside it. That is
// evidence — a signed hire agreement is a contract, and the address it was
// signed from is part of the record of it.
//
// The route read the address like this:
//
//     req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
//
// and that is the FIRST element of the list — which is the element the
// CALLER supplied. nginx sets the header with `$proxy_add_x_forwarded_for`,
// which APPENDS the address it saw to whatever the caller sent, so the list
// arrives as:
//
//     1.2.3.4, 5.6.7.8, <the address nginx saw>
//     ^^^^^^^^  ^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^
//     the        the        the truth
//     caller's   caller's
//
// So the product recorded what the signer said it was, in the very column
// that exists to record where they actually were.
//
// WHAT IS PROVED HERE
// -------------------
// The route records the address nginx saw, and the audit row beside it
// carries the same one.
//
// The route is driven end to end — the real handler, the real signing
// service, the real database — because the thing being proved is what the
// product STORES, and a test that stopped at the route's arguments would
// prove only that the route passed something.
//
// IT NEEDS A DATABASE AND A RUNNING APPLICATION
// ----------------------------------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//   APP_ORIGIN=http://127.0.0.1:55431 \
//   JWT_SHARED_SECRET=... pnpm test
//
// The signing service writes through PostgREST, and PostgREST is reached
// through the application's own origin, so the application has to be
// running. The JWT secret is the one PostgREST verifies the service token
// with, and the two have to be the same value or every write is refused.
//
// IT LEAVES ALMOST NOTHING BEHIND
// -------------------------------
// The chain it creates — the vehicle, the driver, the agreement and the
// signing session — is removed again in the same run. The audit row is NOT
// removed: the audit trail is append-only — there is a trigger on the table
// that raises an exception on any delete — and a test that could delete its
// own evidence would be testing a table nobody can actually edit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { integrationEnv } from '../../helpers/integration-env';
import { POST } from '@/app/api/sign/[token]/submit/route';

type Sql = Awaited<ReturnType<typeof localDb>>;

// The signing service reaches PostgREST through the application, so this one
// needs the application as well as the database.
const env = integrationEnv({ app: true });

/**
 * The tenant every provisioned database carries.
 *
 * It is created by the MIGRATIONS (0017_tenant_scope.sql), not by the demo
 * seed, so it is there on a freshly provisioned database exactly as much as
 * on a developer's. Everything else this file needs, it creates itself — the
 * demo fleet the seed script adds is not part of the schema, and this job
 * does not seed it.
 */
const TENANT = 'b1111111-1111-1111-1111-111111111111';

describe.skipIf(!env)('the address the signing trail records', () => {
  let sql: Sql;
  let sessionId: string;
  let agreementId: string;
  let driverId: string;
  let vehicleId: string;

  const runId = randomUUID().slice(0, 8);

  /** 32 characters of [A-Za-z0-9_-], which is what the app validates. */
  const driverToken = randomUUID().replace(/-/g, '');
  const partnerToken = randomUUID().replace(/-/g, '');

  /** The address nginx saw. */
  const seenAddress = `198.51.100.${(parseInt(runId.slice(0, 2), 16) % 250) + 1}`;
  /** The address the signer CLAIMED. */
  const claimedAddress = '203.0.113.99';

  beforeAll(async () => {
    // The signing service signs its own token with the secret PostgREST
    // verifies it with. Without one it throws, and the failure says nothing
    // about what was being tested.
    if (!process.env.JWT_SHARED_SECRET && !process.env.LOCAL_JWT_SECRET) {
      throw new Error(
        'JWT_SHARED_SECRET is not set. The signing service signs its own token with it, ' +
          'and it has to be the SAME value PostgREST verifies with — otherwise every write ' +
          'is refused and the test fails for a reason that has nothing to do with the address.',
      );
    }

    // The local-auth builds. The SaaS build takes its identity from Supabase
    // Auth and has no local signing service.
    process.env.DEPLOYMENT_PROFILE = 'standalone';

    sql = await localDb();

    // The chain this run signs: a vehicle, a driver, the agreement between
    // them, and the signing session waiting for the driver.
    //
    // Every row is created here. The session used to be built by SELECTing
    // its figures out of a demo agreement that only a seeded database
    // carries: on a freshly provisioned one the SELECT matched nothing, the
    // INSERT wrote no row, and the test failed on the line that read the id
    // back — a failure about a missing row, in a file about the address the
    // trail records.
    const vehicles = (await sql`
      insert into vehicles (tenant_id, registration, list_value_pence)
      values (${TENANT}, ${`ADDR-${runId}`}, 11700000)
      returning id
    `) as Array<{ id: string }>;
    vehicleId = vehicles[0].id;

    const drivers = (await sql`
      insert into drivers (tenant_id, full_name, email)
      values (${TENANT}, ${'A Driver'}, ${`driver.${runId}@example.test`})
      returning id
    `) as Array<{ id: string }>;
    driverId = drivers[0].id;

    // A standard agreement: the gross has to equal the net plus the VAT, and
    // the status is 'draft' so it cannot collide with the one active
    // agreement a vehicle is allowed.
    const agreements = (await sql`
      insert into agreements (
        tenant_id, type, vehicle_id, driver_id, status,
        weekly_gross_pence, weekly_net_pence, weekly_vat_pence,
        deposit_pence, excess_mile_pence
      )
      values (
        ${TENANT}, 'standard', ${vehicleId}, ${driverId}, 'draft',
        82500, 68750, 13750, 100000, 100
      )
      returning id
    `) as Array<{ id: string }>;
    agreementId = agreements[0].id;

    // The signing session waiting for the driver.
    const rows = (await sql`
      insert into signing_sessions (
        tenant_id, agreement_id, reference, status,
        partner_token, driver_token,
        weekly_gross_pence, deposit_pence, vehicle_value_pence, per_mile_pence
      )
      values (
        ${TENANT}, ${agreementId}, ${`AGR-ADDR-${runId}`}, 'driver_sign',
        ${partnerToken}, ${driverToken},
        82500, 100000, 3500000, 100
      )
      returning id
    `) as Array<{ id: string }>;
    sessionId = rows[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    // The chain, from the top: the session names the agreement, the agreement
    // names the vehicle and the driver. Each delete is guarded, because a
    // beforeAll that failed leaves some of them unset — and an undefined value
    // sent to postgres is an error that would bury the failure that actually
    // happened.
    if (sessionId) await sql`delete from signing_sessions where id = ${sessionId}`;
    if (agreementId) await sql`delete from agreements where id = ${agreementId}`;
    if (driverId) await sql`delete from drivers where id = ${driverId}`;
    if (vehicleId) await sql`delete from vehicles where id = ${vehicleId}`;
    await sql.end({ timeout: 5 });
  });

  it('records the address nginx saw, not the one the signer claimed', async () => {
    const response = await POST(
      new NextRequest(`https://fleet.example.com/api/sign/${driverToken}/submit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `${claimedAddress}, ${seenAddress}`,
        },
        body: JSON.stringify({
          driverName: 'A Driver',
          signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        }),
      }),
      { params: Promise.resolve({ token: driverToken }) },
    );

    expect(response.status, 'the signature was not accepted').toBe(200);

    const rows = (await sql`
      select signer_ip from signing_sessions where id = ${sessionId}
    `) as Array<{ signer_ip: string | null }>;

    expect(rows[0].signer_ip).toBe(seenAddress);
    expect(rows[0].signer_ip).not.toBe(claimedAddress);
  });

  it('puts the same address in the audit row', async () => {
    const rows = (await sql`
      select detail from audit_log
       where entity_id = ${sessionId} and action = 'signing.driver_signed'
    `) as Array<{ detail: { ip?: string | null } | null }>;

    expect(rows.length, 'the signing was not audited').toBeGreaterThan(0);
    expect(rows[0].detail?.ip).toBe(seenAddress);
    expect(rows[0].detail?.ip).not.toBe(claimedAddress);
  });
});
