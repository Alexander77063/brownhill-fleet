// tests/integration/accounting/invoice-void.test.ts
//
// A6 — voiding an invoice by reversal, against a real postgres.
//
// WHAT THIS FILE EXISTS FOR
// -------------------------
// The schema has carried the vocabulary for this since migration 0064:
// `accounting.journal_source_type` has 'invoice_void', `accounting.audit_action`
// has 'invoice_voided', the chart of accounts has 2120 Refunds Payable, and
// `public.invoice_status` has 'void'. The PRODUCT had no way to void an
// invoice at all: an invoice raised by mistake stayed on the books forever,
// because there is no edit path and no cancel path. The operator's only
// options were to live with it or to close the month and reopen it — and the
// second one does not exist either.
//
// So the last piece is the reversal: an invoice is cancelled by posting the
// mirror of its own posting, in the month that posting belongs to, and
// marking the invoice void in the same transaction.
//
// THE PROPERTIES
// --------------
//
//   1. The reversal lands in the ORIGINAL posting's month. Not the month the
//      operator pressed the button. A void is a correction to a document, and
//      a correction belongs beside the document: an invoice issued in March
//      and voided in November reverses in March, so March's P&L and VAT
//      return are right without anybody having to remember to reopen March.
//
//   2. The reversal cancels the original EXACTLY. After the void, Trade
//      Debtors, Revenue and VAT Output are all back where they were before
//      the invoice was issued. This is asserted against the ledger, not
//      against the code that wrote it.
//
//   3. Money that has been received becomes a REFUND OWED, not a negative
//      receivable. The invoice debited Trade Debtors for the gross and the
//      payment credited it for the gross, so the account is already at zero;
//      a reversal that credited it again would leave it at minus the gross —
//      a negative asset — when what is true is that the operator owes the
//      customer their money back. That is 2120 Refunds Payable.
//
//   4. The invoice is marked void in the SAME transaction as the reversal, and
//      an audit row names the operator who did it.
//
//   5. It is refused, not half-done, when it cannot be done: an invoice that
//      is already void, a period that has been closed, an invoice belonging to
//      another tenant.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { withJournalTx } from '@/lib/accounting/journal-bridge';
import { postInvoiceToLedger, postPaymentToLedger } from '@/lib/accounting/gl-posting';
import { voidInvoiceByReversal } from '@/lib/accounting/invoice-void';
import { AccountingPeriodError, closePeriod, openPeriod } from '@/lib/accounting/periods';
import type { ISql } from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the invoice-void tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

describe.skipIf(!DATABASE_URL)('voiding an invoice by reversal, against a real postgres', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const slug = `void-${tenantId.slice(0, 8)}`;

  const ctx = { userId, tenantId };

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Invoice void test', ${slug})
    `;
    // The journal's `posted_by_user_id` references auth.users(id), and the
    // audit row's `user_id` does too.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}::uuid, ${`${slug}@brownhill.test`}, '{"role":"ops"}'::jsonb)
    `;

    const accounts = (await sql`
      select code, id from accounting.chart_of_accounts
       where code in ('1100', '1200', '2200', '2120', '4000') and tenant_id is null
    `) as Array<{ code: string; id: string }>;
    const found = new Set(accounts.map((a) => a.code));
    for (const code of ['1100', '1200', '2200', '2120', '4000']) {
      if (!found.has(code)) {
        throw new Error(`The chart of accounts is missing ${code}.`);
      }
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from accounting.journal_lines where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.journal_entries where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.audit_log where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.periods where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.tenant_accounting_settings where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.payment_allocations where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.payments where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.invoices where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.agreements where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.vehicles where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.drivers where tenant_id = ${tenantId}::uuid`;
    await sql`delete from auth.users where id = ${userId}::uuid`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
  });

  async function makeAgreement(tag: string): Promise<string> {
    const driverId = randomUUID();
    const vehicleId = randomUUID();
    const agreementId = randomUUID();

    await sql`
      insert into public.drivers (id, full_name, email, status, tenant_id)
      values (${driverId}::uuid, 'Void Driver', ${`driver-${driverId}@brownhill.test`},
              'active', ${tenantId}::uuid)
    `;
    await sql`
      insert into public.vehicles
        (id, registration, make, model, fuel, list_value_pence, status, tenant_id)
      values (${vehicleId}::uuid, ${`VD${vehicleId.slice(0, 6).toUpperCase()}`},
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
    void tag;
    return agreementId;
  }

  async function makeInvoice(args: {
    agreementId: string;
    number: string;
    issuedOn: string;
    gross: bigint;
    net: bigint;
    vat: bigint;
  }): Promise<string> {
    const rows = (await sql`
      insert into public.invoices
        (tenant_id, agreement_id, number, issued_on, due_on,
         gross_pence, net_pence, vat_pence, status)
      values (${tenantId}::uuid, ${args.agreementId}::uuid, ${args.number},
              ${args.issuedOn}::date, ${args.issuedOn}::date,
              ${args.gross.toString()}, ${args.net.toString()}, ${args.vat.toString()},
              'open'::public.invoice_status)
      returning id
    `) as Array<{ id: string }>;
    return rows[0].id;
  }

  /** Post an invoice to the ledger, the way the rent cron does. */
  async function postInvoice(invoiceId: string, issuedOn: string): Promise<string> {
    const journalId = await withJournalTx((tx) =>
      postInvoiceToLedger(tx, ctx, {
        id: invoiceId,
        netPence: 10000n,
        vatPence: 2000n,
        grossPence: 12000n,
        issuedOn,
      }),
    );
    expect(journalId).toBeTruthy();
    return journalId as string;
  }

  /** The month's a journal entry landed in. */
  async function periodOf(journalId: string): Promise<{ year: number; month: number }> {
    const rows = (await sql`
      select p.year, p.month
        from accounting.journal_entries je
        join accounting.periods p on p.id = je.period_id
       where je.id = ${journalId}::uuid
    `) as Array<{ year: number; month: number }>;
    return rows[0];
  }

  /** The net balance of every account this tenant has posted to. */
  async function ledgerBalances(): Promise<Map<string, bigint>> {
    const rows = (await sql`
      select coa.code,
             coalesce(sum(l.debit_pence), 0) - coalesce(sum(l.credit_pence), 0) as net
        from accounting.chart_of_accounts coa
        left join accounting.journal_lines l
               on l.account_id = coa.id and l.tenant_id = ${tenantId}::uuid
       where coa.tenant_id is null
       group by coa.code
    `) as Array<{ code: string; net: string }>;
    return new Map(rows.map((r) => [r.code, BigInt(r.net)]));
  }

  async function invoiceStatus(invoiceId: string): Promise<string | null> {
    const rows = (await sql`
      select status::text as status from public.invoices where id = ${invoiceId}::uuid
    `) as Array<{ status: string }>;
    return rows[0]?.status ?? null;
  }

  it('reverses the invoice into the month the invoice was ISSUED, not the month it was voided', async () => {
    const agreement = await makeAgreement('period');
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'VOID-PERIOD-0001',
      issuedOn: '2026-03-14',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });
    await postInvoice(invoiceId, '2026-03-14');

    const result = await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, invoiceId));

    expect(result.outcome).toBe('voided');
    expect(result.journalId).toBeTruthy();
    // March — the invoice's own month — not the month this test runs in.
    expect(await periodOf(result.journalId as string)).toEqual({ year: 2026, month: 3 });
    expect(result.period).toEqual({ year: 2026, month: 3 });
  });

  it('cancels the invoice exactly: every account is back where it was', async () => {
    const agreement = await makeAgreement('balances');
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'VOID-BALANCE-0001',
      issuedOn: '2026-04-10',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });

    const before = await ledgerBalances();
    await postInvoice(invoiceId, '2026-04-10');
    const afterPosting = await ledgerBalances();

    // The posting moved the accounts: debtors up by the gross, revenue and VAT
    // down by their own amounts.
    expect(afterPosting.get('1100')! - before.get('1100')!).toBe(12000n);
    expect(afterPosting.get('4000')! - before.get('4000')!).toBe(-10000n);
    expect(afterPosting.get('2200')! - before.get('2200')!).toBe(-2000n);

    await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, invoiceId));

    const afterVoid = await ledgerBalances();
    expect(afterVoid.get('1100'), 'Trade Debtors did not come back to zero').toBe(
      before.get('1100')!,
    );
    expect(afterVoid.get('4000'), 'Revenue did not come back to zero').toBe(
      before.get('4000')!,
    );
    expect(afterVoid.get('2200'), 'VAT Output did not come back to zero').toBe(
      before.get('2200')!,
    );
  });

  it('marks the invoice void and writes an audit row naming the operator', async () => {
    const agreement = await makeAgreement('audit');
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'VOID-AUDIT-0001',
      issuedOn: '2026-05-02',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });
    await postInvoice(invoiceId, '2026-05-02');

    await withJournalTx((tx) =>
      voidInvoiceByReversal(tx, ctx, invoiceId, 'raised against the wrong vehicle'),
    );

    expect(await invoiceStatus(invoiceId)).toBe('void');

    const audit = (await sql`
      select action::text as action, entity, entity_id::text as entity_id,
             user_id::text as user_id, after
        from accounting.audit_log
       where tenant_id = ${tenantId}::uuid
         and action = 'invoice_voided'
         and entity_id = ${invoiceId}::uuid
    `) as Array<{
      action: string;
      entity: string;
      entity_id: string;
      user_id: string;
      after: Record<string, unknown> | null;
    }>;

    expect(audit.length, 'no invoice_voided audit row was written').toBe(1);
    expect(audit[0].entity).toBe('invoice');
    expect(audit[0].user_id).toBe(userId);
    expect(audit[0].after?.reason).toBe('raised against the wrong vehicle');
  });

  it('turns money that has been received into a refund owed, not a negative receivable', async () => {
    const agreement = await makeAgreement('paid');
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'VOID-PAID-0001',
      issuedOn: '2026-06-05',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });
    await postInvoice(invoiceId, '2026-06-05');

    // The customer pays, and the payment is allocated to the invoice.
    const paymentRows = (await sql`
      insert into public.payments
        (tenant_id, agreement_id, source, idempotency_key,
         amount_pence, received_on, status)
      values (${tenantId}::uuid, ${agreement}::uuid, 'manual',
              ${`void-paid-${invoiceId}`}, 12000, '2026-06-10'::date, 'confirmed')
      returning id
    `) as Array<{ id: string }>;
    const paymentId = paymentRows[0].id;

    await sql`
      insert into public.payment_allocations (tenant_id, payment_id, invoice_id, amount_pence)
      values (${tenantId}::uuid, ${paymentId}::uuid, ${invoiceId}::uuid, 12000)
    `;
    await withJournalTx((tx) =>
      postPaymentToLedger(tx, ctx, {
        id: paymentId,
        amountPence: 12000n,
        receivedOn: '2026-06-10',
      }),
    );

    const before = await ledgerBalances();
    expect(before.get('1100'), 'the payment did not clear the debtors').toBe(0n);

    const result = await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, invoiceId));

    expect(result.outcome).toBe('voided');
    expect(result.refundPence).toBe(12000n);

    const after = await ledgerBalances();
    // Trade Debtors is still zero — the invoice was paid and is now cancelled,
    // so nothing is owed and nothing is negative.
    expect(after.get('1100'), 'Trade Debtors went negative on a paid void').toBe(0n);
    // The refund is a liability: the operator owes the customer £120 back.
    expect(after.get('2120'), 'the refund was not booked as a liability').toBe(-12000n);
    // Revenue and VAT are still reversed in full.
    expect(after.get('4000')).toBe(0n);
    expect(after.get('2200')).toBe(0n);
  });

  it('refuses a second void, and does not post the reversal twice', async () => {
    const agreement = await makeAgreement('twice');
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'VOID-TWICE-0001',
      issuedOn: '2026-07-03',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });
    await postInvoice(invoiceId, '2026-07-03');

    const first = await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, invoiceId));
    expect(first.outcome).toBe('voided');

    const second = await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, invoiceId));
    expect(second.outcome).toBe('already_void');
    expect(second.journalId).toBeNull();

    const entries = (await sql`
      select id from accounting.journal_entries
       where tenant_id = ${tenantId}::uuid
         and source_type = 'invoice_void'
         and source_id = ${invoiceId}::uuid
    `) as Array<{ id: string }>;
    expect(entries.length, 'the invoice was reversed twice').toBe(1);
  });

  it('refuses when the month the invoice belongs to has been closed, and names the month', async () => {
    const agreement = await makeAgreement('closed');
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'VOID-CLOSED-0001',
      issuedOn: '2026-08-07',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });
    await postInvoice(invoiceId, '2026-08-07');

    await openPeriod(tenantId, 2026, 8);
    await closePeriod(tenantId, 2026, 8, userId);

    let error: unknown = null;
    try {
      await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, invoiceId));
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AccountingPeriodError);
    expect((error as AccountingPeriodError).code).toBe('period_closed');
    expect((error as AccountingPeriodError).year).toBe(2026);
    expect((error as AccountingPeriodError).month).toBe(8);

    // Nothing was written: the invoice is still open and no reversal exists.
    expect(await invoiceStatus(invoiceId)).toBe('open');
    const entries = (await sql`
      select id from accounting.journal_entries
       where tenant_id = ${tenantId}::uuid
         and source_type = 'invoice_void'
         and source_id = ${invoiceId}::uuid
    `) as Array<{ id: string }>;
    expect(entries.length).toBe(0);
  });

  it('refuses another tenant\'s invoice', async () => {
    const otherTenant = randomUUID();
    const otherAgreement = randomUUID();
    const otherDriver = randomUUID();
    await sql`
      insert into public.tenants (id, name, slug)
      values (${otherTenant}::uuid, 'Someone else', ${`other-${otherTenant.slice(0, 8)}`})
    `;
    await sql`
      insert into public.drivers (id, full_name, email, status, tenant_id)
      values (${otherDriver}::uuid, 'Other Driver', ${`other-${otherDriver}@brownhill.test`},
              'active', ${otherTenant}::uuid)
    `;
    const vehicleId = randomUUID();
    await sql`
      insert into public.vehicles
        (id, registration, make, model, fuel, list_value_pence, status, tenant_id)
      values (${vehicleId}::uuid, ${`OT${vehicleId.slice(0, 6).toUpperCase()}`},
              'Mercedes-Benz', 'S580e 4MATIC Long', 'phev', 11700000,
              'on_hire', ${otherTenant}::uuid)
    `;
    await sql`
      insert into public.agreements
        (id, type, vehicle_id, driver_id, status, start_date,
         weekly_gross_pence, weekly_net_pence, weekly_vat_pence, tenant_id)
      values (${otherAgreement}::uuid, 'standard', ${vehicleId}::uuid, ${otherDriver}::uuid,
              'active', '2026-01-05', 12000, 10000, 2000, ${otherTenant}::uuid)
    `;

    const rows = (await sql`
      insert into public.invoices
        (tenant_id, agreement_id, number, issued_on, due_on,
         gross_pence, net_pence, vat_pence, status)
      values (${otherTenant}::uuid, ${otherAgreement}::uuid, 'VOID-OTHER-0001',
              '2026-09-01'::date, '2026-09-01'::date, 12000, 10000, 2000,
              'open'::public.invoice_status)
      returning id
    `) as Array<{ id: string }>;
    const otherInvoiceId = rows[0].id;

    const result = await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, otherInvoiceId));
    expect(result.outcome).toBe('not_found');

    const status = (await sql`
      select status::text as status from public.invoices where id = ${otherInvoiceId}::uuid
    `) as Array<{ status: string }>;
    expect(status[0].status).toBe('open');

    await sql`delete from public.invoices where tenant_id = ${otherTenant}::uuid`;
    await sql`delete from public.agreements where tenant_id = ${otherTenant}::uuid`;
    await sql`delete from public.vehicles where tenant_id = ${otherTenant}::uuid`;
    await sql`delete from public.drivers where tenant_id = ${otherTenant}::uuid`;
    await sql`delete from public.tenants where id = ${otherTenant}::uuid`;
  });

  it('voids an invoice that was never posted, and says so', async () => {
    // An invoice raised before the ledger was wired has no posting to
    // reverse. There is nothing in the accounts to cancel, so nothing is
    // posted — but the invoice is still cancelled, because the operator asked
    // for it to be and it is not owed.
    const agreement = await makeAgreement('unposted');
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'VOID-UNPOSTED-0001',
      issuedOn: '2026-10-02',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });

    const result = await withJournalTx((tx) => voidInvoiceByReversal(tx, ctx, invoiceId));

    expect(result.outcome).toBe('voided');
    expect(result.noLedgerEntry).toBe(true);
    expect(result.journalId).toBeNull();
    expect(await invoiceStatus(invoiceId)).toBe('void');

    const entries = (await sql`
      select id from accounting.journal_entries
       where tenant_id = ${tenantId}::uuid
         and source_type = 'invoice_void'
         and source_id = ${invoiceId}::uuid
    `) as Array<{ id: string }>;
    expect(entries.length).toBe(0);
  });
});
