// src/lib/accounting/invoice-eligibility.ts
//
// Which invoices may still receive money.
//
// This is the one place the rule is written down. Three callers depend on it
// and they must agree: the reconciliation queue decides what the operator is
// offered, the reconcile API decides what it accepts, and the payment ingest
// decides what it pays down. If they disagree, an invoice can be offered and
// then refused — or, worse, refused nowhere and paid against a cancelled
// invoice.
//
// `void` is the state that disqualifies an invoice on its own: the invoice has
// been cancelled, so nothing is owed on it. `paid` is disqualified because
// nothing is outstanding — the trigger that maintains `invoices.status` sets it
// to `paid` only once the allocations have reached the gross. The remaining
// three states all mean "this invoice still owes money", and `overdue` is the
// one an operator most needs to be able to match a receipt against: an invoice
// that has gone overdue is exactly the one a late payment arrives for.
//
// The column is the PostgreSQL enum `invoice_status`, whose values are
// exactly: open, paid, part_paid, void, overdue.

export const ALLOCATABLE_INVOICE_STATUSES = ['open', 'part_paid', 'overdue'] as const;

export type AllocatableInvoiceStatus = (typeof ALLOCATABLE_INVOICE_STATUSES)[number];

/**
 * Whether money may still be allocated to an invoice in this state.
 */
export function isAllocatableInvoiceStatus(
  status: string | null | undefined,
): status is AllocatableInvoiceStatus {
  return (
    typeof status === 'string' &&
    (ALLOCATABLE_INVOICE_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Why an invoice may not receive money, in words safe to show an operator.
 *
 * Returns null when the invoice is fine. The message never carries an amount,
 * a balance or any other figure from the ledger — it says what is wrong with
 * the invoice, not what is in it.
 */
export function invoiceAllocationRejection(
  status: string | null | undefined,
): string | null {
  if (status === 'void') return 'That invoice has been voided and cannot receive a payment.';
  if (status === 'paid') return 'That invoice is already settled in full.';
  if (!isAllocatableInvoiceStatus(status)) {
    return 'That invoice cannot receive a payment.';
  }
  return null;
}
