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

export interface UnmatchedRow {
  id: string;
  bank_account_name: string;
  posted_at: string;
  amount_pence: string;
  description: string;
  counterparty: string | null;
}

export interface OpenInvoiceRow {
  id: string;
  number: string | null;
  issued_on: string;
  gross_pence: string;
  /** What has already been allocated to this invoice. */
  allocated_pence: string;
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
    select bt.id, ba.name as bank_account_name, bt.posted_at, bt.amount_pence,
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
    select i.id, i.number, i.issued_on, i.gross_pence,
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
