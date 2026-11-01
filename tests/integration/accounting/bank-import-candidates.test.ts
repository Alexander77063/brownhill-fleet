// tests/integration/accounting/bank-import-candidates.test.ts
//
// The invoice dates the bank importer matches receipts against, against a
// real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// The importer scores each imported bank line against the open invoices, and
// one of the three terms is a date window: a receipt counts (0.1) when it
// arrives within 30 days of the invoice being issued.
//
// That term was dead. `public.invoices.issued_on` is a `date` column, and
// postgres.js hands a raw `date` back as a JavaScript Date. The importer
// built the issue date with
//
//     new Date(c.issued_on + 'T00:00:00Z')
//
// and `+` with a string on the right coerces the Date through `toString()`:
// "Sun Nov 01 2026 00:00:00 GMT+0000 (Greenwich Mean Time)T00:00:00Z".
// That is not a date, so the result was an Invalid Date, `daysAfter` was
// NaN, and `daysAfter >= 0 && daysAfter <= 30` never fired.
//
// This file reads the candidates through the same loader the importer uses,
// against the real schema, and asserts the shape the scorer depends on.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant, user and documents, and removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import * as reconcileQueue from '@/lib/accounting/reconcile-queue';
import { scoreMatch, type MatchCandidate } from '@/lib/accounting/bank-rec';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the bank importer candidate tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

interface CandidateRow {
  invoice_id: string;
  gross_pence: string;
  invoice_no: string | null;
  issued_on: string;
  agreement_id: string | null;
  driver_id: string | null;
  allocated_pence: string;
}

describe.skipIf(!DATABASE_URL)('the bank importer, against a real postgres', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const slug = `import-candidates-${tenantId.slice(0, 8)}`;

  const ISSUED_ON = '2026-10-01';

  let invoiceId = '';

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Bank importer candidates test', ${slug})
    `;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}::uuid, ${`${slug}@brownhill.test`}, '{"role":"ops"}'::jsonb)
    `;

    const driverId = randomUUID();
    const vehicleId = randomUUID();
    const agreementId = randomUUID();

    await sql`
      insert into public.drivers (id, full_name, email, status, tenant_id)
      values (${driverId}::uuid, 'Import Candidates Driver', ${`driver-${driverId}@brownhill.test`},
              'active', ${tenantId}::uuid)
    `;
    await sql`
      insert into public.vehicles
        (id, registration, make, model, fuel, list_value_pence, status, tenant_id)
      values (${vehicleId}::uuid, ${`IC${vehicleId.slice(0, 6).toUpperCase()}`},
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

    invoiceId = randomUUID();
    await sql`
      insert into public.invoices
        (id, tenant_id, agreement_id, number, issued_on, due_on,
         gross_pence, net_pence, vat_pence, status)
      values (${invoiceId}::uuid, ${tenantId}::uuid, ${agreementId}::uuid, 'IC-0001',
              ${ISSUED_ON}::date, ${ISSUED_ON}::date,
              12000, 10000, 2000, 'open'::public.invoice_status)
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.payment_allocations where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.invoices where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.agreements where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.vehicles where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.drivers where tenant_id = ${tenantId}::uuid`;
    await sql`delete from auth.users where id = ${userId}::uuid`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
  });

  it('loads the issue day as a day string, not a Date', async () => {
    // The loader the importer uses to build its match candidates.
    const load = (
      reconcileQueue as unknown as {
        loadAutoMatchCandidates?: (sql: unknown, tenantId: string) => Promise<CandidateRow[]>;
      }
    ).loadAutoMatchCandidates;
    expect(typeof load, 'the importer has no reachable candidate loader to test').toBe('function');

    const rows = await load!(sql, tenantId);
    const row = rows.find((r) => r.invoice_id === invoiceId);
    expect(row, 'the open invoice is not a match candidate').toBeTruthy();

    expect(
      typeof row!.issued_on,
      'issued_on came back as a Date, so the importer built an Invalid Date and the 30-day window never fired',
    ).toBe('string');
    expect(row!.issued_on).toBe(ISSUED_ON);
  });

  it('builds a real issue date from the loaded day', async () => {
    const load = (
      reconcileQueue as unknown as {
        loadAutoMatchCandidates?: (sql: unknown, tenantId: string) => Promise<CandidateRow[]>;
      }
    ).loadAutoMatchCandidates;
    expect(typeof load, 'the importer has no reachable candidate loader to test').toBe('function');

    const rows = await load!(sql, tenantId);
    const row = rows.find((r) => r.invoice_id === invoiceId)!;

    // The expression the importer uses to build `issuedAt`.
    const issuedAt = new Date(row.issued_on + 'T00:00:00Z');
    expect(Number.isNaN(issuedAt.getTime()), 'the issue date is not a date').toBe(false);
    expect(issuedAt.toISOString()).toBe(`${ISSUED_ON}T00:00:00.000Z`);
  });

  it('scores a receipt five days after issue at full confidence', async () => {
    const load = (
      reconcileQueue as unknown as {
        loadAutoMatchCandidates?: (sql: unknown, tenantId: string) => Promise<CandidateRow[]>;
      }
    ).loadAutoMatchCandidates;
    expect(typeof load, 'the importer has no reachable candidate loader to test').toBe('function');

    const rows = await load!(sql, tenantId);
    const row = rows.find((r) => r.invoice_id === invoiceId)!;

    const candidate: MatchCandidate = {
      paymentId: row.invoice_id,
      grossPence: BigInt(row.gross_pence),
      invoiceNo: row.invoice_no ?? '',
      issuedAt: new Date(row.issued_on + 'T00:00:00Z'),
    };

    const withinWindow = scoreMatch(
      {
        postedAt: new Date('2026-10-06T00:00:00.000Z'),
        amountPence: BigInt(row.gross_pence),
        description: `payment for ${row.invoice_no}`,
        counterparty: null,
      },
      candidate,
    );
    // 0.5 exact amount + 0.4 invoice number in the description + 0.1 the
    // 30-day date window.
    expect(withinWindow).toBeCloseTo(1.0, 5);

    const outsideWindow = scoreMatch(
      {
        postedAt: new Date('2026-11-20T00:00:00.000Z'),
        amountPence: BigInt(row.gross_pence),
        description: `payment for ${row.invoice_no}`,
        counterparty: null,
      },
      candidate,
    );
    // The same receipt, 50 days later: the window does not apply.
    expect(outsideWindow).toBeCloseTo(0.9, 5);
  });
});
