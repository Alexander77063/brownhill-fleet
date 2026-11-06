// tests/integration/accounting/invoices-to-journal.test.ts
//
// The two automatic accounting rules, against a real postgres.
//
// WHAT THIS FILE EXISTS FOR
// -------------------------
// The design spec names two automatic postings:
//
//   Rule #1, invoice issued:   Dr Trade Debtors (1100) / Cr Revenue (4000) / Cr VAT Output (2200)
//   Rule #2, payment confirmed: Dr Bank (1200) / Cr Trade Debtors (1100)
//
// `postInvoiceJournal` and `postPaymentJournal` existed, the balance trigger
// existed, the reconciliation queue's "match" button posted rule #2 by hand —
// and the rent cron raised invoices and the payment ingest took money without
// either rule ever reaching the ledger.
//
// The consequence was not a rounding error. The operator's trial balance did
// not contain the business they were running: it contained the handful of bank
// lines somebody had reconciled by hand, and nothing else. Rent was billed and
// never appeared in the accounts. Money arrived and never appeared either.
//
// THE PROPERTIES
// --------------
//
//   1. An invoice and its ledger entry land TOGETHER, or neither lands.
//      A posting refused — a closed period, a missing account — must leave
//      no invoice behind. An invoice the accounts do not know about is a bill
//      the operator has sent and not recorded; a ledger entry for an invoice
//      that does not exist is revenue nobody can point at.
//
//   2. The entry lands in the DOCUMENT's month, not the month the posting
//      happened to be made in. An invoice belongs to the month it was issued;
//      a payment belongs to the month the money was received. The rent cron
//      backfills every week since the agreement started, so an invoice for
//      last month is raised today — and it belongs to last month, because that
//      is when the VAT became due.
//
//   3. The entry balances, and the accounts are the ones the chart of
//      accounts names — never a literal id.
//
//   4. A zero-rated invoice posts without a VAT line. `journal_lines` carries
//      `check ((debit_pence > 0) <> (credit_pence > 0))`, so a line that is
//      zero on BOTH sides is not a zero line — it is an ILLEGAL line. Rule #1
//      always emits three lines, so a zero-rated invoice produced a VAT line
//      of (0, 0), the whole posting rolled back, and the rent for that week
//      was never billed.
//
//   5. Money is applied to the OLDEST debt first, and never to a void
//      invoice.
//
//   6. Posting the same document twice does not post it twice.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD — a skipped check and a passing check look the
// same in a build log, and this one is worth knowing about.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant, user, drivers, vehicles and agreements, and
// removes them afterwards.
//
// EACH TEST GETS ITS OWN AGREEMENT
// ---------------------------------
// The allocation rule is scoped to an agreement's invoices, so two tests that
// shared an agreement would see each other's invoices and each other's
// balances. The first draft of this file did exactly that, and three tests
// failed for that reason alone — which is worth saying out loud, because the
// failures looked exactly like bugs in the allocation rule and were not.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { withJournalTx } from '@/lib/accounting/journal-bridge';
import { postInvoiceToLedger, postPaymentToLedger } from '@/lib/accounting/gl-posting';
import { allocatePaymentToInvoices } from '@/lib/accounting/allocation';
import { requireInferredVatCodeId } from '@/lib/accounting/vat-codes';
import { AccountingPeriodError, closePeriod, openPeriod } from '@/lib/accounting/periods';
import type { ISql } from 'postgres';
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

describe.skipIf(!env)('the ledger against real invoices and real payments', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const slug = `gl-wiring-${tenantId.slice(0, 8)}`;

  const ctx = { userId, tenantId };

  /** The global chart-of-accounts ids the two rules post to. */
  const coa = new Map<string, string>();

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'GL wiring test', ${slug})
    `;
    // The journal's `posted_by_user_id` references auth.users(id), so the
    // poster has to be a real user row — the same thing a session carries.
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userId}::uuid, ${`${slug}@brownhill.test`}, '{"role":"ops"}'::jsonb)
    `;

    const accounts = (await sql`
      select code, id from accounting.chart_of_accounts
       where code in ('1100', '1200', '2200', '4000') and tenant_id is null
    `) as Array<{ code: string; id: string }>;
    for (const a of accounts) coa.set(a.code, a.id);
    for (const code of ['1100', '1200', '2200', '4000']) {
      if (!coa.has(code)) {
        throw new Error(`The chart of accounts is missing ${code}.`);
      }
    }
  });

  afterAll(async () => {
    if (!sql) return;
    // In dependency order: the tenant cannot go until nothing points at it.
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

  /**
   * A fresh agreement, with its own driver and vehicle.
   *
   * One per test, so the allocation rule never sees another test's invoices.
   */
  async function makeAgreement(): Promise<string> {
    const driverId = randomUUID();
    const vehicleId = randomUUID();
    const agreementId = randomUUID();

    await sql`
      insert into public.drivers (id, full_name, email, status, tenant_id)
      values (${driverId}::uuid, 'GL Wiring Driver', ${`driver-${driverId}@brownhill.test`},
              'active', ${tenantId}::uuid)
    `;
    await sql`
      insert into public.vehicles
        (id, registration, make, model, fuel, list_value_pence, status, tenant_id)
      values (${vehicleId}::uuid, ${`GL${vehicleId.slice(0, 6).toUpperCase()}`},
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
    return agreementId;
  }

  /**
   * Insert an invoice and return its id.
   *
   * `exec` is the connection to write through. The atomicity test passes the
   * transaction handle, so the invoice is genuinely part of the transaction
   * being rolled back — writing it through the pool would leave it behind
   * whatever the posting did, and the test would prove nothing.
   */
  async function makeInvoice(
    args: {
      agreementId: string;
      number: string;
      issuedOn: string;
      dueOn?: string;
      gross: bigint;
      net: bigint;
      vat: bigint;
      status?: 'open' | 'void' | 'paid' | 'part_paid' | 'overdue';
    },
    exec: ISql = sql,
  ): Promise<string> {
    const rows = (await exec`
      insert into public.invoices
        (tenant_id, agreement_id, number, issued_on, due_on,
         gross_pence, net_pence, vat_pence, status)
      values (${tenantId}::uuid, ${args.agreementId}::uuid, ${args.number},
              ${args.issuedOn}::date, ${(args.dueOn ?? args.issuedOn)}::date,
              ${args.gross.toString()}, ${args.net.toString()}, ${args.vat.toString()},
              ${(args.status ?? 'open')}::public.invoice_status)
      returning id
    `) as Array<{ id: string }>;
    return rows[0].id;
  }

  /** Insert a payment and return its id. */
  async function makePayment(args: {
    agreementId: string;
    key: string;
    amount: bigint;
    receivedOn: string;
  }): Promise<string> {
    const rows = (await sql`
      insert into public.payments
        (tenant_id, agreement_id, source, idempotency_key,
         amount_pence, received_on, status)
      values (${tenantId}::uuid, ${args.agreementId}::uuid,
              'manual', ${args.key}, ${args.amount.toString()},
              ${args.receivedOn}::date, 'confirmed')
      returning id
    `) as Array<{ id: string }>;
    return rows[0].id;
  }

  /** The lines of a journal entry, as {code, debit, credit}. */
  async function linesOf(journalId: string) {
    const rows = (await sql`
      select coa.code, l.debit_pence, l.credit_pence
        from accounting.journal_lines l
        join accounting.chart_of_accounts coa on coa.id = l.account_id
       where l.journal_id = ${journalId}::uuid
       order by coa.code
    `) as Array<{ code: string; debit_pence: string; credit_pence: string }>;
    return rows.map((r) => ({
      code: r.code,
      debit: BigInt(r.debit_pence),
      credit: BigInt(r.credit_pence),
    }));
  }

  /** The month a journal entry landed in. */
  async function periodOf(journalId: string): Promise<{ year: number; month: number }> {
    const rows = (await sql`
      select p.year, p.month
        from accounting.journal_entries je
        join accounting.periods p on p.id = je.period_id
       where je.id = ${journalId}::uuid
    `) as Array<{ year: number; month: number }>;
    return rows[0];
  }

  // ── rule #1: the invoice ──────────────────────────────────────────────────

  it('posts an invoice to the ledger in the month it was ISSUED', async () => {
    const agreement = await makeAgreement();
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'GL-T1-0001',
      issuedOn: '2026-03-14',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });

    const journalId = await withJournalTx(async (tx) => {
      const id = await postInvoiceToLedger(tx, ctx, {
        id: invoiceId,
        netPence: 10000n,
        vatPence: 2000n,
        grossPence: 12000n,
        issuedOn: '2026-03-14',
      });
      expect(id).toBeTruthy();
      return id as string;
    });

    // Dr Trade Debtors / Cr Revenue / Cr VAT Output.
    const lines = await linesOf(journalId);
    expect(lines).toEqual([
      { code: '1100', debit: 12000n, credit: 0n },
      { code: '2200', debit: 0n, credit: 2000n },
      { code: '4000', debit: 0n, credit: 10000n },
    ]);

    // The entry is in March, not in the month the posting was made in.
    expect(await periodOf(journalId)).toEqual({ year: 2026, month: 3 });

    // The invoice points at its own entry.
    const row = (await sql`
      select posted_journal_id::text as posted_journal_id
        from public.invoices where id = ${invoiceId}::uuid
    `) as Array<{ posted_journal_id: string | null }>;
    expect(row[0].posted_journal_id).toBe(journalId);
  });

  it('posts a zero-rated invoice WITHOUT a VAT line', async () => {
    // `journal_lines` carries `check ((debit_pence > 0) <> (credit_pence > 0))`.
    // A VAT line of (0, 0) is not a zero line — it is an ILLEGAL line, and it
    // takes the whole posting down with it. Zero-rated rent is real money, and
    // this week of it was never billed because of it.
    const agreement = await makeAgreement();
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'GL-T0-0001',
      issuedOn: '2026-04-02',
      gross: 10000n,
      net: 10000n,
      vat: 0n,
    });

    const journalId = await withJournalTx(async (tx) => {
      const id = await postInvoiceToLedger(tx, ctx, {
        id: invoiceId,
        netPence: 10000n,
        vatPence: 0n,
        grossPence: 10000n,
        issuedOn: '2026-04-02',
      });
      expect(id).toBeTruthy();
      return id as string;
    });

    const lines = await linesOf(journalId);
    expect(lines).toEqual([
      { code: '1100', debit: 10000n, credit: 0n },
      { code: '4000', debit: 0n, credit: 10000n },
    ]);
    expect(lines.some((l) => l.code === '2200'), 'a zero-rated invoice wrote a VAT line').toBe(false);
  });

  it('leaves NO invoice behind when the ledger refuses the posting', async () => {
    // The atomicity, end to end. The period is shut, so the posting is
    // refused — and because the invoice and its entry are ONE transaction,
    // the invoice is not created either. A rent invoice the accounts do not
    // know about is a bill the operator has sent and not recorded.
    await openPeriod(tenantId, 2026, 5);
    await closePeriod(tenantId, 2026, 5, userId);

    const agreement = await makeAgreement();
    let error: unknown = null;
    let invoiceId = '';
    try {
      await withJournalTx(async (tx) => {
        invoiceId = await makeInvoice(
          {
            agreementId: agreement,
            number: 'GL-CLOSED-0001',
            issuedOn: '2026-05-10',
            gross: 12000n,
            net: 10000n,
            vat: 2000n,
          },
          tx,
        );
        await postInvoiceToLedger(tx, ctx, {
          id: invoiceId,
          netPence: 10000n,
          vatPence: 2000n,
          grossPence: 12000n,
          issuedOn: '2026-05-10',
        });
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AccountingPeriodError);
    expect((error as AccountingPeriodError).code).toBe('period_closed');
    expect((error as AccountingPeriodError).month).toBe(5);
    expect(invoiceId, 'the invoice was never even written').toBeTruthy();

    // The invoice did not survive the rollback.
    const invoices = (await sql`
      select id from public.invoices
       where tenant_id = ${tenantId}::uuid and number = 'GL-CLOSED-0001'
    `) as Array<{ id: string }>;
    expect(invoices.length, 'the invoice was created even though the posting was refused').toBe(0);

    // And no ledger entry was written for it either — an entry for an invoice
    // that does not exist is revenue nobody can point at.
    const entries = (await sql`
      select id from accounting.journal_entries
       where tenant_id = ${tenantId}::uuid
         and source_type = 'invoice'
         and source_id = ${invoiceId}::uuid
    `) as Array<{ id: string }>;
    expect(entries.length).toBe(0);
  });

  it('does not post the same invoice twice', async () => {
    const agreement = await makeAgreement();
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'GL-IDEMP-0001',
      issuedOn: '2026-09-01',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });

    const post = () =>
      withJournalTx((tx) =>
        postInvoiceToLedger(tx, ctx, {
          id: invoiceId,
          netPence: 10000n,
          vatPence: 2000n,
          grossPence: 12000n,
          issuedOn: '2026-09-01',
        }),
      );

    const first = await post();
    const second = await post();

    expect(first).toBeTruthy();
    // The journal's idempotency key is (tenant_id, source_type, source_id),
    // so the second call finds the entry the first one made.
    expect(second).toBe(first);

    const entries = (await sql`
      select id from accounting.journal_entries
       where tenant_id = ${tenantId}::uuid
         and source_type = 'invoice' and source_id = ${invoiceId}::uuid
    `) as Array<{ id: string }>;
    expect(entries.length, 'the invoice was posted twice').toBe(1);
  });

  // ── rule #2: the payment ─────────────────────────────────────────────────

  it('posts a payment to the ledger in the month the money was RECEIVED', async () => {
    const agreement = await makeAgreement();
    const paymentId = await makePayment({
      agreementId: agreement,
      key: 'GL-PAY-0001',
      amount: 12000n,
      receivedOn: '2026-06-05',
    });

    const journalId = await withJournalTx(async (tx) => {
      const id = await postPaymentToLedger(tx, ctx, {
        id: paymentId,
        amountPence: 12000n,
        receivedOn: '2026-06-05',
      });
      expect(id).toBeTruthy();
      return id as string;
    });

    // Dr Bank / Cr Trade Debtors.
    const lines = await linesOf(journalId);
    expect(lines).toEqual([
      { code: '1100', debit: 0n, credit: 12000n },
      { code: '1200', debit: 12000n, credit: 0n },
    ]);

    expect(await periodOf(journalId)).toEqual({ year: 2026, month: 6 });

    const row = (await sql`
      select posted_journal_id::text as posted_journal_id
        from public.payments where id = ${paymentId}::uuid
    `) as Array<{ posted_journal_id: string | null }>;
    expect(row[0].posted_journal_id).toBe(journalId);
  });

  it('pays down the OLDEST debt first', async () => {
    const agreement = await makeAgreement();
    const older = await makeInvoice({
      agreementId: agreement,
      number: 'GL-FIFO-A',
      issuedOn: '2026-07-01',
      dueOn: '2026-07-01',
      gross: 10000n,
      net: 8333n,
      vat: 1667n,
    });
    const newer = await makeInvoice({
      agreementId: agreement,
      number: 'GL-FIFO-B',
      issuedOn: '2026-07-08',
      dueOn: '2026-07-08',
      gross: 10000n,
      net: 8333n,
      vat: 1667n,
    });
    const paymentId = await makePayment({
      agreementId: agreement,
      key: 'GL-PAY-FIFO',
      amount: 15000n,
      receivedOn: '2026-07-10',
    });

    const result = await withJournalTx((tx) =>
      allocatePaymentToInvoices(tx, {
        paymentId,
        agreementId: agreement,
        amountPence: 15000n,
        tenantId,
      }),
    );

    expect(result.allocatedPence).toBe(15000n);
    expect(result.lines).toEqual([
      { invoiceId: older, amountPence: 10000n },
      { invoiceId: newer, amountPence: 5000n },
    ]);
  });

  it('never allocates money to a void invoice', async () => {
    // A voided invoice has been cancelled: nothing is owed on it, so money
    // must not be recorded against it. The candidate query excludes void
    // invoices, and the database refuses the allocation too (migration 0082)
    // — which is what protects the race where an invoice is cancelled
    // between the read and the write.
    const agreement = await makeAgreement();
    const cancelled = await makeInvoice({
      agreementId: agreement,
      number: 'GL-VOID-A',
      issuedOn: '2026-08-01',
      dueOn: '2026-08-01',
      gross: 10000n,
      net: 8333n,
      vat: 1667n,
      status: 'void',
    });
    const live = await makeInvoice({
      agreementId: agreement,
      number: 'GL-VOID-B',
      issuedOn: '2026-08-08',
      dueOn: '2026-08-08',
      gross: 10000n,
      net: 8333n,
      vat: 1667n,
    });
    const paymentId = await makePayment({
      agreementId: agreement,
      key: 'GL-PAY-VOID',
      amount: 10000n,
      receivedOn: '2026-08-10',
    });

    const result = await withJournalTx((tx) =>
      allocatePaymentToInvoices(tx, {
        paymentId,
        agreementId: agreement,
        amountPence: 10000n,
        tenantId,
      }),
    );

    expect(result.lines).toEqual([{ invoiceId: live, amountPence: 10000n }]);
    expect(result.lines.some((l) => l.invoiceId === cancelled)).toBe(false);

    // And the database agrees: nothing is allocated to the void invoice.
    const allocations = (await sql`
      select invoice_id::text as invoice_id, amount_pence
        from public.payment_allocations
       where tenant_id = ${tenantId}::uuid and payment_id = ${paymentId}::uuid
    `) as Array<{ invoice_id: string; amount_pence: string }>;
    expect(allocations.length).toBe(1);
    expect(allocations[0].invoice_id).toBe(live);
  });

  it('leaves money that no invoice claims unallocated', async () => {
    // The customer's credit, not an invented invoice to absorb it.
    const agreement = await makeAgreement();
    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'GL-PARTIAL',
      issuedOn: '2026-10-01',
      dueOn: '2026-10-01',
      gross: 5000n,
      net: 4166n,
      vat: 834n,
    });
    const paymentId = await makePayment({
      agreementId: agreement,
      key: 'GL-PAY-OVER',
      amount: 12000n,
      receivedOn: '2026-10-05',
    });

    const result = await withJournalTx((tx) =>
      allocatePaymentToInvoices(tx, {
        paymentId,
        agreementId: agreement,
        amountPence: 12000n,
        tenantId,
      }),
    );

    expect(result.allocatedPence).toBe(5000n);
    expect(result.lines).toEqual([{ invoiceId, amountPence: 5000n }]);
  });

  // ── the VAT code the return aggregates on ─────────────────────────────────

  it('carries the VAT code the return aggregates on', async () => {
    // `public.invoices.vat_code_id` existed since migration 0067 and nothing
    // ever wrote it. The VAT return groups on it, so every invoice landed
    // under a null code and box 1 was permanently £0 while box 4 carried the
    // whole of the sales net.
    const agreement = await makeAgreement();
    const standard = await requireInferredVatCodeId(sql, 2000n, tenantId);
    const zero = await requireInferredVatCodeId(sql, 0n, tenantId);
    expect(standard).not.toBe(zero);

    const invoiceId = await makeInvoice({
      agreementId: agreement,
      number: 'GL-VATCODE-0001',
      issuedOn: '2026-11-01',
      gross: 12000n,
      net: 10000n,
      vat: 2000n,
    });
    await sql`
      update public.invoices set vat_code_id = ${standard}::uuid
       where id = ${invoiceId}::uuid
    `;

    // The return's own grouping now sees this invoice under T1.
    const grouped = (await sql`
      select vc.code, sum(i.net_pence) as net_pence, sum(i.vat_pence) as vat_pence
        from public.invoices i
        join accounting.vat_codes vc on vc.id = i.vat_code_id
       where i.tenant_id = ${tenantId}::uuid and i.status <> 'void'
       group by vc.code
    `) as Array<{ code: string; net_pence: string; vat_pence: string }>;
    expect(grouped.some((g) => g.code === 'T1')).toBe(true);
  });
});
