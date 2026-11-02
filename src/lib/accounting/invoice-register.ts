// src/lib/accounting/invoice-register.ts
// The invoice list behind the invoice register, shared by the two consoles
// that show it (/accounts/accounting/invoices for the accountant,
// /admin/accounting/invoices for the operator).
//
// WHY THIS EXISTS
// ---------------
// The product had NO invoice list anywhere.
//
// Invoices surfaced in exactly two places: the reconciliation queue's match
// picker — which lists only the invoices a bank line can still be matched
// to, so an invoice that was paid, or voided, or simply old was invisible —
// and the reports, which are summaries and not a working list.
//
// So an operator who needed to answer "which invoices have we issued, which
// are paid, which are still owed, and what is this one for?" had nowhere to
// go. That is the question a finance conversation starts with, and there was
// no page that answered it.
//
// It is also the surface the void needs: a correction the operator cannot
// see is a correction nobody performs. (See ./invoice-void.ts.)
//
// THE TENANT
// ----------
// The accounting schema is not exposed by PostgREST and the application
// connects as the superuser, which bypasses RLS. So the tenant is named in
// every statement here — on the invoice, on the agreement, on the driver and
// on the vehicle. The joins put the tenant predicate in the ON clause, not
// the WHERE clause: a LEFT JOIN with the tenant in the WHERE turns it into
// an INNER JOIN and drops the invoice entirely.
//
// MONEY IS A STRING
// -----------------
// The amounts are bigint columns, and they come back as strings so that no
// value passes through a JavaScript number. A float cannot hold every penny
// of a large invoice, and a money table that rounds is a money table that is
// wrong.

import { localDb } from '@/lib/auth/local-store';
import type { InvoiceRegisterRow, InvoiceStatus } from '@/lib/accounting/invoice-shared';

// THE SPLIT
// ---------
// The row shape and the money helpers live in ./invoice-shared, which the
// BROWSER may import. This module may not: it opens the application's direct
// database connection, and that connection lives behind `import 'server-only'`
// (via @/lib/auth/local-store). A 'use client' component importing from here
// therefore fails the production build — which is exactly how the Void
// control broke it before the split.
//
// They are re-exported here so the server pages keep importing one module.
// The client component imports ./invoice-shared DIRECTLY, never this one.
export type { InvoiceRegisterRow, InvoiceStatus };
export { formatPence, outstandingPence } from '@/lib/accounting/invoice-shared';

type Sql = Awaited<ReturnType<typeof localDb>>;

export interface InvoiceRegisterQuery {
  /** How many rows at most. */
  limit?: number;
  /** One status, or 'all' (the default). */
  status?: InvoiceStatus | 'all';
}

/**
 * The tenant's invoices, newest first.
 *
 * `limit` is applied in SQL rather than in JavaScript, so a tenant with ten
 * thousand invoices does not pull ten thousand rows into the process to
 * display twenty. The status filter is applied in SQL for the same reason:
 * filtering after the limit would show twenty invoices and then throw away
 * most of them, so the page would claim there are three open invoices when
 * there are three hundred.
 */
export async function listInvoices(
  tenantId: string,
  query: InvoiceRegisterQuery = {},
): Promise<InvoiceRegisterRow[]> {
  const sql = await localDb();
  const limit = query.limit ?? 100;
  const status = query.status ?? 'all';

  // THE STATUS FILTER IS A FRAGMENT, NOT A PARAMETER
  // -----------------------------------------------
  // It used to be one bound parameter, used twice:
  //
  //     and (${status} = 'all' or i.status = ${status}::invoice_status)
  //
  // Postgres resolves a parameter's type from the context that constrains it,
  // and the explicit cast is what constrains it — so the parameter was bound
  // as an `invoice_status`, and 'all' is not a member of that enum. Every
  // call with the default filter died with
  //
  //     invalid input value for enum invoice_status: "all"
  //
  // and the two register pages answered HTTP 500. The single-status path
  // worked, which is why it looked like a display bug on one page rather than
  // a broken query.
  //
  // Two things are wanted, and one parameter cannot give both:
  //
  //   * 'all' must never reach the database. It is not a status; it is the
  //     absence of a filter.
  //   * a real status must be compared AS an enum, because there is a btree
  //     index on public.invoices.status and comparing the text instead would
  //     defeat it and scan every invoice the tenant has.
  //
  // So the filter goes into the statement only when it is a real status, and
  // then it is bound exactly once, as the enum it is.
  //
  // The 'all' branch is `and true` rather than an empty fragment: postgres.js
  // stringifies an empty fragment as the literal text "undefined", which is
  // not a filter but a syntax error.
  const statusFilter =
    status === 'all'
      ? sql`and true`
      : sql`and i.status = ${status}::public.invoice_status`;

  return (await sql`
    select i.id, i.number,
           i.issued_on::text as issued_on,
           i.due_on::text as due_on,
           i.gross_pence, i.net_pence, i.vat_pence,
           i.status::text as status,
           d.full_name as customer_name,
           v.registration as vehicle_registration,
           coalesce((select sum(pa.amount_pence)
                       from public.payment_allocations pa
                       join public.payments p
                         on p.id = pa.payment_id
                        and p.tenant_id = ${tenantId}::uuid
                        and p.status = 'confirmed'::payment_status
                      where pa.invoice_id = i.id
                        and pa.tenant_id = ${tenantId}::uuid), 0)::bigint as allocated_pence,
           i.posted_journal_id
      from public.invoices i
      left join public.agreements a
             on a.id = i.agreement_id
            and a.tenant_id = ${tenantId}::uuid
      left join public.drivers d
             on d.id = a.driver_id
            and d.tenant_id = ${tenantId}::uuid
      left join public.vehicles v
             on v.id = a.vehicle_id
            and v.tenant_id = ${tenantId}::uuid
     where i.tenant_id = ${tenantId}::uuid
       ${statusFilter}
     order by i.issued_on desc, i.created_at desc
     limit ${limit}
  `) as unknown as InvoiceRegisterRow[];
}

/**
 * How many invoices the tenant has in each status.
 *
 * Counted in SQL rather than from the rows on screen: the list is capped at
 * a hundred, so counting it would count the hundred, not the truth.
 */
export async function countInvoicesByStatus(
  tenantId: string,
): Promise<Record<InvoiceStatus, number>> {
  const sql = await localDb();
  const rows = (await sql`
    select i.status::text as status, count(*)::bigint as n
      from public.invoices i
     where i.tenant_id = ${tenantId}::uuid
     group by i.status
  `) as Array<{ status: InvoiceStatus; n: string }>;

  const counts: Record<InvoiceStatus, number> = {
    open: 0,
    paid: 0,
    part_paid: 0,
    void: 0,
    overdue: 0,
  };
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = Number(row.n);
  }
  return counts;
}
