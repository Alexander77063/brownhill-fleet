// src/lib/accounting/allocation.ts
// Applying money to the invoices it pays down.
//
// WHY THIS EXISTS
// ---------------
// Three places in the product allocated a payment to invoices, and each had
// its own implementation:
//
//   * the payment ingest (a provider webhook, a manual bank entry),
//   * the operator's "record a payment" action,
//   * the reconciliation queue's "match this bank line" button.
//
// They agreed on WHICH invoices may receive money — that rule lives in
// `invoice-eligibility.ts` — but not on HOW, and not on whether the
// allocation survived the rest of the write. The reconciliation queue did its
// work in one transaction; the other two did theirs in a sequence of separate
// statements, so an allocation could land without the payment, or the payment
// without the allocation.
//
// WHO CALLS THE SHARED RULE, EXACTLY
// ---------------------------------
// The reconciliation queue (`reconcile-queue.ts`) and the reconciliation API
// (`/api/v1/accounting/reconcile`) call `invoice-eligibility.ts` directly, so
// what the operator is offered and what the API accepts cannot disagree.
// THIS file states the same three statuses in SQL instead of importing the
// constant, because the list has to reach postgres as a literal list of
// values. The two can drift — a status added to the enum and to the constant
// would not be added here — and the drift fails CLOSED: a status this query
// does not name is not offered to the allocation, so no money is moved
// against it. `check_allocation` (migration 0082) is the arbiter either way.
//
// This is the one implementation, and it runs on a transaction handle the
// caller supplies. The payment row, its allocations and its ledger entry are
// then one transaction, and any of them can be missing only if all of them
// are.
//
// THE ORDER
// ---------
// Oldest debt first: `due_on`, then `issued_on`, then `created_at`.
//
// The two callers that used to disagree — one ordered by `issued_on`, the
// other by `due_on` — differ only for an invoice the product did not raise
// itself. Every invoice the rent cron raises is issued and due on the same
// day (the week's period start), and so is every seeded one, so the two
// orders agree in practice. Where they would differ, "most overdue first" is
// the right rule for both: money pays down the debt that has been waiting
// longest.
//
// THE DATABASE IS THE ARBITER
// ---------------------------
// `check_allocation` (migration 0082) locks the invoice, then the payment,
// refuses a void invoice, and caps the allocations at the payment amount and
// at the invoice's gross. This function computes how much to allocate; the
// trigger decides whether the allocation is allowed. Where the two disagree
// — because an invoice was voided or paid between this function's read and
// its write — the trigger wins and the invoice is skipped.

import type { Sql } from './journal-bridge';

/** One invoice's share of a payment. */
export interface AllocationLine {
  invoiceId: string;
  amountPence: bigint;
}

export interface AllocationResult {
  /** How much of the payment was applied to invoices. */
  allocatedPence: bigint;
  lines: AllocationLine[];
}

/**
 * Apply a payment to an agreement's outstanding invoices, oldest debt first.
 *
 * `tx` is a transaction handle. The allocation is written through it, so it
 * commits with whatever else the caller is doing — including the ledger
 * posting.
 *
 * Money that no invoice claims stays unallocated: the payment row records the
 * full amount, and the excess is the customer's credit. Nothing here invents
 * an invoice to absorb it.
 */
export async function allocatePaymentToInvoices(
  tx: Sql,
  args: {
    paymentId: string;
    agreementId: string;
    amountPence: bigint;
    tenantId: string;
  },
): Promise<AllocationResult> {
  const { paymentId, agreementId, amountPence, tenantId } = args;
  if (amountPence <= 0n) return { allocatedPence: 0n, lines: [] };

  // The candidate invoices, with the balance each still owes. This is a read
  // of the world as it is now; the write below is arbitrated by the trigger,
  // so a balance that has moved in between is caught rather than trusted.
  const candidates = (await tx`
    select i.id,
           i.gross_pence,
           coalesce((select sum(pa.amount_pence)
                       from public.payment_allocations pa
                      where pa.invoice_id = i.id
                        and pa.tenant_id = ${tenantId}::uuid), 0)::bigint as allocated_pence
      from public.invoices i
     where i.agreement_id = ${agreementId}::uuid
       and i.tenant_id = ${tenantId}::uuid
       and i.status in ('open', 'part_paid', 'overdue')
     order by i.due_on asc, i.issued_on asc, i.created_at asc
  `) as Array<{ id: string; gross_pence: string; allocated_pence: string }>;

  let remaining = amountPence;
  const lines: AllocationLine[] = [];

  for (const inv of candidates) {
    if (remaining <= 0n) break;

    const outstanding = BigInt(inv.gross_pence) - BigInt(inv.allocated_pence);
    if (outstanding <= 0n) continue;

    // The lesser of what is left and what the invoice still owes.
    const take = remaining < outstanding ? remaining : outstanding;

    // The allocation is written inside a SAVEPOINT, so a refusal by the
    // database guard rolls back to this point and leaves the transaction
    // usable. Without one, the first refused allocation would poison every
    // statement after it — and the payment would be lost with it.
    let inserted: Array<{ id: string }> = [];
    try {
      await tx.savepoint(async (sp) => {
        inserted = await sp`
          insert into public.payment_allocations
            (payment_id, invoice_id, amount_pence, tenant_id)
          values (${paymentId}::uuid, ${inv.id}::uuid, ${take.toString()},
                  ${tenantId}::uuid)
          on conflict (payment_id, invoice_id) do nothing
          returning id
        `;
      });
    } catch {
      // The guard refused this invoice — it was voided, or it was paid, or it
      // was locked by somebody else's allocation, between the read above and
      // this write. The refusal is the point of the guard, so it is honoured:
      // the invoice is skipped and the money moves on to the next one.
      continue;
    }

    // `on conflict do nothing` inserts no row when the allocation is already
    // there, and an allocation that was not made must not be counted.
    if (!inserted.length) continue;

    remaining -= take;
    lines.push({ invoiceId: inv.id, amountPence: take });
  }

  return { allocatedPence: amountPence - remaining, lines };
}
