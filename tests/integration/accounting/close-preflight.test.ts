// tests/integration/accounting/close-preflight.test.ts
//
// The close preflight's counts, against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// The Close button closed a month with one click and no warning. The spec
// asks for "Close period (warns: locks all postings; shows affected counts;
// confirm modal)" — nothing warned, nothing counted, and nothing confirmed.
//
// The warnings themselves are pure functions of the counts and are tested
// without a database in tests/unit/accounting/close-preflight.test.ts. This
// file proves the COUNTS are true, because a warning built on a wrong count
// is worse than no warning: the operator reads a number, believes it, and
// closes the month anyway.
//
// WHAT THIS FILE PROVES
// ---------------------
//   1. An uncategorised bank line dated in the period is counted, with its
//      amount. A bank line posts into the month the BANK posted it, so once
//      that month is closed the categorisation is refused — the count is the
//      number of categorisations the close would strand.
//   2. A bank line from another month, or one that has already been
//      categorised, is not counted. Over-counting teaches the operator to
//      ignore the number.
//   3. Another tenant's bank line is not counted. The accounting schema is
//      not exposed by PostgREST and the app connects as a superuser, which
//      bypasses RLS — so the tenant has to be named in the SQL, and this is
//      the test that proves it is.
//   4. The net VAT for the period is read from the invoices, and the VAT
//      warning goes away once HMRC has accepted the return.
//   5. An invoice that is still owed is counted but is NOT a warning: it
//      stays a receivable after the close.
//   6. A closed period says so, and says it cannot be closed again.
//   7. The counts are plain numbers, not BigInt — they are serialised into a
//      JSON response, and `JSON.stringify` throws on a BigInt.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenants and its own rows, and removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { closePeriod, openPeriod } from '@/lib/accounting/periods';
import { preflightPeriodClose } from '@/lib/accounting/close-preflight';
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

describe.skipIf(!env)('the close preflight', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const slug = `preflight-${tenantId.slice(0, 8)}`;
  const otherSlug = `preflight-other-${otherTenantId.slice(0, 8)}`;
  const closer = randomUUID();

  /** The year/month under test. October 2026 — far enough from now that no
   *  other fixture can land in it by accident. */
  const YEAR = 2026;
  const MONTH = 10;

  let agreementId: string;
  let vatCodeId: string;
  let periodId: string;
  let bankAccountId: string;

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values
        (${tenantId}::uuid, 'Close preflight test', ${slug}),
        (${otherTenantId}::uuid, 'Another tenant', ${otherSlug})
    `;
    await sql`
      insert into auth.users (id, email)
      values (${closer}::uuid, ${`preflight-${closer.slice(0, 8)}@example.invalid`})
    `;

    // The chain an invoice hangs off: tenant → driver → vehicle → agreement.
    const driver = (await sql`
      insert into public.drivers (full_name, tenant_id)
      values ('Preflight Driver', ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;

    const vehicle = (await sql`
      insert into public.vehicles (registration, list_value_pence, tenant_id)
      values (${`PRE-${tenantId.slice(0, 8)}`}, 1000000, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;

    const agreement = (await sql`
      insert into public.agreements
        (type, vehicle_id, driver_id, status, weekly_gross_pence, weekly_net_pence,
         weekly_vat_pence, tenant_id)
      values ('standard', ${vehicle[0].id}::uuid, ${driver[0].id}::uuid, 'draft',
              12000, 10000, 2000, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    agreementId = agreement[0].id;

    // The standard-rated VAT code the return is computed from. The global
    // seed is used when there is one; otherwise this tenant gets its own.
    const globalVat = (await sql`
      select id from accounting.vat_codes where code = 'T1' and tenant_id is null limit 1
    `) as Array<{ id: string }>;
    if (globalVat.length) {
      vatCodeId = globalVat[0].id;
    } else {
      const own = (await sql`
        insert into accounting.vat_codes (code, rate_pct, description, tenant_id)
        values ('T1', 20, 'Standard rated', ${tenantId}::uuid)
        returning id
      `) as Array<{ id: string }>;
      vatCodeId = own[0].id;
    }

    // The period under test, and a bank account to hang the bank lines on.
    const period = await openPeriod(tenantId, YEAR, MONTH);
    periodId = period.id;

    const bankAccount = (await sql`
      insert into accounting.bank_accounts (name, gl_account_id, tenant_id)
      select 'Preflight Bank', coa.id, ${tenantId}::uuid
        from accounting.chart_of_accounts coa
       where coa.code = '1200' and coa.tenant_id is null
      returning id
    `) as Array<{ id: string }>;
    bankAccountId = bankAccount[0].id;

    const importRow = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, tenant_id)
      values (${bankAccountId}::uuid, 'preflight.csv', ${'0011223344556677'}::bytea,
              ${periodId}::uuid, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;

    // ── the bank lines ─────────────────────────────────────────────────────
    // One uncategorised line dated inside the period. This is the line the
    // close would strand.
    await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${importRow[0].id}::uuid, ${bankAccountId}::uuid,
              '2026-10-14T09:00:00Z'::timestamptz, 45000, 'October rent receipt',
              'unmatched', ${tenantId}::uuid)
    `;
    // One from the month before — not this period's business.
    await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${importRow[0].id}::uuid, ${bankAccountId}::uuid,
              '2026-09-30T09:00:00Z'::timestamptz, 9000, 'September receipt',
              'unmatched', ${tenantId}::uuid)
    `;
    // One from the month after — likewise.
    await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${importRow[0].id}::uuid, ${bankAccountId}::uuid,
              '2026-11-02T09:00:00Z'::timestamptz, 7000, 'November receipt',
              'unmatched', ${tenantId}::uuid)
    `;
    // One inside the period that has already been categorised — not stranded.
    await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${importRow[0].id}::uuid, ${bankAccountId}::uuid,
              '2026-10-20T09:00:00Z'::timestamptz, 3000, 'October fee, categorised',
              'manually_matched', ${tenantId}::uuid)
    `;

    // Another tenant's line, dated in the same month. It must not be counted:
    // the accounting schema is not exposed by PostgREST and the app connects
    // as a superuser, so RLS never filters this query.
    const otherDriver = (await sql`
      insert into public.drivers (full_name, tenant_id)
      values ('Other Driver', ${otherTenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    const otherVehicle = (await sql`
      insert into public.vehicles (registration, list_value_pence, tenant_id)
      values (${`OTH-${otherTenantId.slice(0, 8)}`}, 1000000, ${otherTenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    const otherAgreement = (await sql`
      insert into public.agreements
        (type, vehicle_id, driver_id, status, weekly_gross_pence, weekly_net_pence,
         weekly_vat_pence, tenant_id)
      values ('standard', ${otherVehicle[0].id}::uuid, ${otherDriver[0].id}::uuid, 'draft',
              12000, 10000, 2000, ${otherTenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    const otherPeriod = await openPeriod(otherTenantId, YEAR, MONTH);
    const otherBankAccount = (await sql`
      insert into accounting.bank_accounts (name, gl_account_id, tenant_id)
      select 'Other Bank', coa.id, ${otherTenantId}::uuid
        from accounting.chart_of_accounts coa
       where coa.code = '1200' and coa.tenant_id is null
      returning id
    `) as Array<{ id: string }>;
    const otherImport = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, tenant_id)
      values (${otherBankAccount[0].id}::uuid, 'other.csv', ${'8899aabbccddeeff'}::bytea,
              ${otherPeriod.id}::uuid, ${otherTenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence, description,
         status, tenant_id)
      values (${otherImport[0].id}::uuid, ${otherBankAccount[0].id}::uuid,
              '2026-10-11T09:00:00Z'::timestamptz, 999999, 'Another tenant’s receipt',
              'unmatched', ${otherTenantId}::uuid)
    `;
    void otherAgreement;

    // ── the invoice ────────────────────────────────────────────────────────
    // Net 10 000p, VAT 2 000p. The return's box 7 is the VAT, so the period
    // owes VAT and there is a return to file.
    await sql`
      insert into public.invoices
        (agreement_id, number, issued_on, due_on, gross_pence, net_pence, vat_pence,
         status, tenant_id, vat_code_id)
      values (${agreementId}::uuid, ${`INV-PF-${tenantId.slice(0, 8)}`},
              '2026-10-01'::date, '2026-10-15'::date, 12000, 10000, 2000,
              'open', ${tenantId}::uuid, ${vatCodeId}::uuid)
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from accounting.bank_transactions where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.bank_imports where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.bank_accounts where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.vat_submissions where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from public.invoices where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from public.agreements where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from public.vehicles where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from public.drivers where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.periods where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from accounting.vat_codes where tenant_id = ${tenantId}::uuid`;
    // The audit rows carry a foreign key to the tenant, so they have to go
    // before it does — the period lifecycle writes them now.
    await sql`delete from accounting.audit_log where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from public.tenants where id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
    await sql`delete from auth.users where id = ${closer}::uuid`;
  });

  // ── the bank lines ───────────────────────────────────────────────────────

  it('counts the uncategorised bank lines dated in the period, and their amount', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    // Only the one dated 2026-10-14. The September line, the November line
    // and the already-categorised one are not this period's business.
    expect(preflight.counts.openBankItems).toBe(1);
    expect(preflight.counts.openBankItemsPence).toBe(45_000);
  });

  it('does not count another tenant’s bank lines', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    // The other tenant's line is 999 999p and dated in the same month. If the
    // tenant scope were missing, the count would be 2 and the amount would
    // be 1 044 999p.
    expect(preflight.counts.openBankItems).toBe(1);
    expect(preflight.counts.openBankItemsPence).toBe(45_000);
  });

  it('warns about the bank lines the close would strand, naming the period', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    const warning = preflight.warnings.find((w) => w.code === 'open_bank_items');
    expect(warning).toBeDefined();
    expect(warning!.count).toBe(1);
    expect(warning!.message).toContain('2026-10');
  });

  // ── the VAT ──────────────────────────────────────────────────────────────

  it('reads the net VAT due for the period from the invoices', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    // The invoice is net 10 000p with 2 000p of VAT on it, so box 7 is 2 000p.
    expect(preflight.counts.netVatPence).toBe(2_000);
  });

  it('warns that the VAT return has not been filed', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    expect(preflight.counts.vatSubmission).toBe('none');
    const warning = preflight.warnings.find((w) => w.code === 'vat_not_filed');
    expect(warning).toBeDefined();
    expect(warning!.amountPence).toBe(2_000);
  });

  it('stops warning once HMRC has accepted the return', async () => {
    await sql`
      insert into accounting.vat_submissions
        (period_id, hmtr_correlation_id, return_payload, status, tenant_id)
      values (${periodId}::uuid, 'HMRC-PREFLIGHT-TEST',
              '{"boxes":1}'::jsonb, 'submitted', ${tenantId}::uuid)
    `;

    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    expect(preflight.counts.vatSubmission).toBe('submitted');
    expect(preflight.warnings.find((w) => w.code === 'vat_not_filed')).toBeUndefined();
    // The bank line is still stranded, so the close still warns about it.
    expect(preflight.warnings.find((w) => w.code === 'open_bank_items')).toBeDefined();
  });

  // ── the invoices ─────────────────────────────────────────────────────────

  it('counts the invoices still owed but does not warn about them', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    // An unpaid invoice is a receivable: it survives the close. It is shown
    // as a fact, not as a warning, because the close does not strand it.
    expect(preflight.counts.openInvoices).toBe(1);
    expect(preflight.counts.openInvoicesPence).toBe(12_000);
    expect(preflight.warnings.map((w) => w.code)).not.toContain('open_invoices');
  });

  // ── the period's own state ───────────────────────────────────────────────

  it('says an open period can be closed', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    expect(preflight.period).toBe('2026-10');
    expect(preflight.status).toBe('open');
    expect(preflight.canClose).toBe(true);
    expect(preflight.blockedBy).toBeNull();
  });

  it('says a closed period cannot be closed again, and names it', async () => {
    await closePeriod(tenantId, YEAR, MONTH, closer);

    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    expect(preflight.status).toBe('closed');
    expect(preflight.canClose).toBe(false);
    expect(preflight.blockedBy).toContain('2026-10');
  });

  // ── the wire format ──────────────────────────────────────────────────────

  it('returns counts that can be serialised to JSON', async () => {
    const preflight = await preflightPeriodClose(tenantId, YEAR, MONTH);

    // The counts go into a JSON response, and JSON.stringify throws on a
    // BigInt. A number here is not a style preference — it is the difference
    // between a working preflight and a 500 on the operator's screen.
    expect(typeof preflight.counts.openBankItemsPence).toBe('number');
    expect(typeof preflight.counts.netVatPence).toBe('number');
    expect(() => JSON.stringify(preflight)).not.toThrow();
  });
});
