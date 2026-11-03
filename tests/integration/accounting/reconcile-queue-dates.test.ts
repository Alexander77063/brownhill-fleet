// tests/integration/accounting/reconcile-queue-dates.test.ts
//
// The dates the reconciliation console reads, against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// `/accounts/accounting/reconcile` and `/admin/accounting/reconcile` are the
// screens where money is matched to invoices. Both of them went 500 as soon
// as the queue had anything in it.
//
// The cause is a type mismatch that no unit test could see. This project
// reads through postgres.js, and postgres.js hands a `date` or `timestamptz`
// column back as a JavaScript Date — not as a string. The console does
//
//     r.posted_at.slice(0, 10)
//     inv.issued_on.slice(0, 10)
//
// and `.slice` does not exist on a Date, so the server component threw while
// rendering and the page returned 500.
//
// The unit tests missed it because their fixtures were STRINGS — the very
// shape the database has never produced. This file reads through the real
// loader functions, against the real schema, and asserts the shape the
// console depends on.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD — a skipped check and a passing check look the
// same in a build log, and this one is worth knowing about.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant, user and documents, and removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { loadUnmatched, loadOpenInvoices } from '@/lib/accounting/reconcile-queue';
import { integrationEnv } from '../../helpers/integration-env';

// This file talks straight to postgres and never through the service
// client, so it asks for the database alone.
//
// `integrationEnv` is the repository's rule for this, and it is the rule that
// matters: it SKIPS, out loud, when the job has not asked for the
// integration tests, and it FAILS when the job has set REQUIRE_INTEGRATION=1
// and the database is not there. The hand-rolled guard this replaced skipped
// in BOTH cases — so a build with REQUIRE_INTEGRATION=1 could report this
// file's tests as skipped and still be green. A test that did not run is not
// a test that passed.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('the reconciliation console, against a real postgres', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const slug = `reconcile-dates-${tenantId.slice(0, 8)}`;

  /** The day the bank posted the line, in UTC. */
  const POSTED_AT = '2026-10-01T09:30:00Z';
  const POSTED_ON = '2026-10-01';
  /** The day the invoice was issued. */
  const ISSUED_ON = '2026-10-01';

  let invoiceId = '';
  let bankTxId = '';

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Reconcile console dates test', ${slug})
    `;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}::uuid, ${`${slug}@brownhill.test`}, '{"role":"ops"}'::jsonb)
    `;

    const accounts = (await sql`
      select id from accounting.chart_of_accounts
       where code = '1200' and tenant_id is null
    `) as Array<{ id: string }>;
    if (!accounts.length) {
      throw new Error('The chart of accounts is missing 1200 (Bank).');
    }
    const bankGlId = accounts[0].id;

    const periods = (await sql`
      insert into accounting.periods (tenant_id, year, month)
      values (${tenantId}::uuid, 2026, 10)
      returning id
    `) as Array<{ id: string }>;

    const driverId = randomUUID();
    const vehicleId = randomUUID();
    const agreementId = randomUUID();

    await sql`
      insert into public.drivers (id, full_name, email, status, tenant_id)
      values (${driverId}::uuid, 'Reconcile Dates Driver', ${`driver-${driverId}@brownhill.test`},
              'active', ${tenantId}::uuid)
    `;
    await sql`
      insert into public.vehicles
        (id, registration, make, model, fuel, list_value_pence, status, tenant_id)
      values (${vehicleId}::uuid, ${`RC${vehicleId.slice(0, 6).toUpperCase()}`},
              'Mercedes-Benz', 'S580e 4MATIC Long', 'phev', 11700000,
              'on_hire', ${tenantId}::uuid)
    `;
    await sql`
      insert into public.agreements
        (id, type, vehicle_id, driver_id, status, start_date,
         weekly_gross_pence, weekly_net_pence, weekly_vat_pence, tenant_id)
      values (${agreementId}::uuid, 'standard', ${vehicleId}::uuid, ${driverId}::uuid,
              'active', '2026-01-05', 12000, 10000, 2000, ${tenantId}::uuid)
    `;

    // The invoice the operator is trying to match the receipt against.
    invoiceId = randomUUID();
    await sql`
      insert into public.invoices
        (id, tenant_id, agreement_id, number, issued_on, due_on,
         gross_pence, net_pence, vat_pence, status)
      values (${invoiceId}::uuid, ${tenantId}::uuid, ${agreementId}::uuid, 'RC-0001',
              ${ISSUED_ON}::date, ${ISSUED_ON}::date,
              12000, 10000, 2000, 'open'::public.invoice_status)
    `;

    // ...and the unmatched bank line waiting for it.
    const bankAccountId = randomUUID();
    const bankImportId = randomUUID();
    await sql`
      insert into accounting.bank_accounts (id, name, gl_account_id, tenant_id)
      values (${bankAccountId}::uuid, 'Reconcile dates test', ${bankGlId}::uuid, ${tenantId}::uuid)
    `;
    await sql`
      insert into accounting.bank_imports
        (id, bank_account_id, file_name, file_sha256, period_id, imported_by_user_id, tenant_id)
      values (${bankImportId}::uuid, ${bankAccountId}::uuid, 'reconcile-dates.csv',
              decode('deadbeef', 'hex'), ${periods[0].id}::uuid, ${userId}::uuid, ${tenantId}::uuid)
    `;
    bankTxId = randomUUID();
    await sql`
      insert into accounting.bank_transactions
        (id, bank_import_id, bank_account_id, posted_at, amount_pence,
         description, counterparty, status, tenant_id)
      values (${bankTxId}::uuid, ${bankImportId}::uuid, ${bankAccountId}::uuid,
              ${POSTED_AT}::timestamptz, 12000, 'RC-0001 payment', 'RC-0001',
              'unmatched'::accounting.bank_tx_status, ${tenantId}::uuid)
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from accounting.bank_transactions where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.bank_imports where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.bank_accounts where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.periods where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.payment_allocations where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.invoices where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.agreements where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.vehicles where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.drivers where tenant_id = ${tenantId}::uuid`;
    await sql`delete from auth.users where id = ${userId}::uuid`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
  });

  it('loads the posted day as the string the console slices', async () => {
    const rows = await loadUnmatched(tenantId);
    const row = rows.find((r) => r.id === bankTxId);
    expect(row, 'the unmatched bank line is not in the queue').toBeTruthy();

    // postgres.js hands a raw `timestamptz` back as a Date, and the console
    // calls `.slice(0, 10)` on it.
    expect(
      typeof row!.posted_at,
      'posted_at came back as a Date, so posted_at.slice(0, 10) throws and the console 500s',
    ).toBe('string');
    expect(row!.posted_at).toBe(POSTED_ON);
    // The exact expression src/components/accounting/ReconcileQueue.tsx runs.
    expect(row!.posted_at.slice(0, 10)).toBe(POSTED_ON);
  });

  it('loads the invoice issue day as the string the console slices', async () => {
    const rows = await loadOpenInvoices(tenantId);
    const row = rows.find((r) => r.id === invoiceId);
    expect(row, 'the open invoice is not in the queue').toBeTruthy();

    expect(
      typeof row!.issued_on,
      'issued_on came back as a Date, so issued_on.slice(0, 10) throws and the console 500s',
    ).toBe('string');
    expect(row!.issued_on).toBe(ISSUED_ON);
    // The exact expression src/components/accounting/ReconcileQueue.tsx runs.
    expect(row!.issued_on.slice(0, 10)).toBe(ISSUED_ON);
  });

  it('keeps the queue in date order', async () => {
    // The console shows the oldest line first. Casting the column for the
    // SELECT must not change the ORDER BY, or the operator works through
    // the queue in the wrong order.
    const rows = await loadUnmatched(tenantId);
    const days = rows.map((r) => r.posted_at);
    expect([...days].sort()).toEqual(days);
  });
});
