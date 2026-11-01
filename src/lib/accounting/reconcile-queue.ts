// src/lib/accounting/reconcile-queue.ts
// The data behind the reconciliation queue, shared by the two consoles that
// show it (/accounts/accounting/reconcile for the accountant,
// /admin/accounting/reconcile for the operator).
//
// It used to be duplicated — one copy of the same query in each console — and
// NEITHER copy named the tenant. The accounting schema is not exposed by
// PostgREST and the application connects as a superuser, so RLS never
// filtered those queries: one tenant saw every other tenant's unmatched bank
// lines and the debtors behind them.
//
// One implementation, one place to get the tenant right.
//
// The queries here are tenant-scoped in SQL rather than left to a policy,
// because a policy that never runs is not a policy.

import { localDb } from '@/lib/auth/local-store';
import { ALLOCATABLE_INVOICE_STATUSES } from '@/lib/accounting/invoice-eligibility';

/**
 * A postgres.js connection.
 *
 * The loader that takes one as an argument — `loadAutoMatchCandidates` — is
 * here so the bank importer and its tests can share one implementation.
 */
type Sql = Awaited<ReturnType<typeof localDb>>;

export interface UnmatchedRow {
  id: string;
  bank_account_name: string;
  /**
   * The day the bank posted the line, as 'YYYY-MM-DD'.
   *
   * A string, deliberately: postgres.js hands a raw `timestamptz` back as a
   * JavaScript Date, and the console slices this value with `.slice(0, 10)`.
   */
  posted_at: string;
  amount_pence: string;
  description: string;
  counterparty: string | null;
}

export interface OpenInvoiceRow {
  id: string;
  number: string | null;
  /**
   * The day the invoice was issued, as 'YYYY-MM-DD'.
   *
   * A string, deliberately: postgres.js hands a raw `date` back as a
   * JavaScript Date, and the console slices this value with `.slice(0, 10)`.
   */
  issued_on: string;
  gross_pence: string;
  /** What has already been allocated to this invoice. */
  allocated_pence: string;
}

/**
 * An invoice a bank line can be auto-matched against.
 *
 * The same open invoices the reconcile queue offers, plus the agreement and
 * driver the importer needs to write the payment.
 */
export interface AutoMatchCandidateRow {
  invoice_id: string; // the matcher is keyed on "paymentId"; here that is the invoice
  gross_pence: string;
  allocated_pence: string;
  invoice_no: string | null;
  /**
   * The day the invoice was issued, as 'YYYY-MM-DD'.
   *
   * A string, deliberately — see `OpenInvoiceRow.issued_on`. The importer
   * turns this into the `Date` the scorer compares against.
   */
  issued_on: string;
  agreement_id: string | null;
  driver_id: string | null;
}

/** What is still owed on an invoice. */
export function outstandingPence(invoice: OpenInvoiceRow): bigint {
  const gross = BigInt(invoice.gross_pence);
  const allocated = BigInt(invoice.allocated_pence);
  const outstanding = gross - allocated;
  return outstanding > 0n ? outstanding : 0n;
}

/**
 * The bank lines waiting to be categorised, oldest first.
 *
 * Tenant-scoped on both sides of the join: a bank account belonging to
 * another tenant must not drag its transactions in either.
 */
export async function loadUnmatched(tenantId: string): Promise<UnmatchedRow[]> {
  const sql = await localDb();
  return (await sql`
    select bt.id, ba.name as bank_account_name,
           to_char(bt.posted_at at time zone 'UTC', 'YYYY-MM-DD') as posted_at,
           bt.amount_pence,
           bt.description, bt.counterparty
      from accounting.bank_transactions bt
      join accounting.bank_accounts ba on ba.id = bt.bank_account_id
     where bt.status = 'unmatched'
       and bt.tenant_id = ${tenantId}::uuid
       and ba.tenant_id = ${tenantId}::uuid
     order by bt.posted_at
  `) as unknown as UnmatchedRow[];
}

/**
 * The invoices a bank line can be matched to — the ones still owed money.
 *
 * The operator picks the invoice; the reconcile API needs that id, and
 * without it the "Match" button has nothing to match against.
 */
export async function loadOpenInvoices(tenantId: string): Promise<OpenInvoiceRow[]> {
  const sql = await localDb();
  const rows = (await sql`
    select i.id, i.number, i.issued_on::text as issued_on, i.gross_pence,
           coalesce((select sum(pa.amount_pence)
                       from public.payment_allocations pa
                      where pa.invoice_id = i.id
                        and pa.tenant_id = ${tenantId}::uuid), 0)::bigint as allocated_pence
      from public.invoices i
     where i.tenant_id = ${tenantId}::uuid
       and i.status = any(${ALLOCATABLE_INVOICE_STATUSES}::invoice_status[])
     order by i.issued_on desc
  `) as unknown as OpenInvoiceRow[];
  // An invoice that is already settled in full is not a candidate. The
  // `open` status is kept in step by the `sync_invoice_status()` trigger, but
  // the arithmetic is the truth, so the filter is applied here rather than
  // trusted.
  return rows.filter((r) => outstandingPence(r) > 0n);
}

/**
 * The invoices a freshly imported bank line can be auto-matched against.
 *
 * The same open invoices the reconcile queue offers, minus the ones a bank
 * line has already been matched to, plus the agreement and driver the
 * importer needs to write the payment.
 *
 * The importer used to run this query itself, inline, where it could not be
 * tested — and the date it read came back as a JavaScript Date, which killed
 * the 30-day window in the auto-matcher. Here the day is cast to text at the
 * source, so the value is 'YYYY-MM-DD' whatever the driver does.
 */
export async function loadAutoMatchCandidates(
  sql: Sql,
  tenantId: string,
): Promise<AutoMatchCandidateRow[]> {
  return (await sql`
    select i.id as invoice_id,
           i.gross_pence,
           i.number as invoice_no,
           i.issued_on::text as issued_on,
           i.agreement_id,
           a.driver_id,
           coalesce((select sum(pa.amount_pence)
                       from public.payment_allocations pa
                      where pa.invoice_id = i.id
                        and pa.tenant_id = ${tenantId}::uuid), 0)::bigint as allocated_pence
      from public.invoices i
      left join public.agreements a
             on a.id = i.agreement_id
            and a.tenant_id = ${tenantId}::uuid
     where i.status = any(${ALLOCATABLE_INVOICE_STATUSES}::invoice_status[])
       and i.tenant_id = ${tenantId}::uuid
       and not exists (
         select 1 from accounting.bank_transactions bt
          where bt.matched_payment_id = i.id
            and bt.tenant_id = ${tenantId}::uuid
       )
     order by i.issued_on desc
  `) as unknown as AutoMatchCandidateRow[];
}
