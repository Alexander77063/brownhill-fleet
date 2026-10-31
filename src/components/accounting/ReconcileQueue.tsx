// src/components/accounting/ReconcileQueue.tsx
// The reconciliation queue, shared by the two consoles that host it
// (/accounts/accounting/reconcile for the accountant,
// /admin/accounting/reconcile for the operator).
//
// It used to be duplicated — one copy of the table in each console — and both
// copies had the same defect: a "Match" button with no way to say WHICH
// invoice the money belongs to. The API behind it needs an invoice id, so
// clicking Match returned a 400 and the operator had no way to settle a
// receipt without leaving the screen.
//
// The invoice picker therefore lives here, once, and both consoles get it.
//
// Each bank line carries two forms. The first matches it to an invoice — its
// picker is `required`, so the browser refuses to submit a match with no
// invoice chosen. The second categorises it as a VAT payment, a bank charge or
// something to ignore; those need no invoice, and putting them in their own
// form is what lets the picker be mandatory for the one case that needs it.

import type { OpenInvoiceRow, UnmatchedRow } from '@/lib/accounting/reconcile-queue';
import { outstandingPence } from '@/lib/accounting/reconcile-queue';

export interface ReconcileQueueProps {
  rows: UnmatchedRow[];
  invoices: OpenInvoiceRow[];
  /** Where the form returns to after a categorisation. */
  returnTo: string;
}

/** £1,234.56 — pence in, pounds out. */
export function fmtPence(p: string): string {
  const n = BigInt(p);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}£${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function ReconcileQueue({ rows, invoices, returnTo }: ReconcileQueueProps) {
  return (
    <table className="min-w-full border">
      <thead>
        <tr>
          <th className="text-left p-2">Date</th>
          <th className="text-left p-2">Bank</th>
          <th className="text-left p-2">Amount</th>
          <th className="text-left p-2">Description</th>
          <th className="text-left p-2">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="p-2">{r.posted_at.slice(0, 10)}</td>
            <td className="p-2">{r.bank_account_name}</td>
            <td className="p-2">{fmtPence(r.amount_pence)}</td>
            <td className="p-2">{r.description}</td>
            <td className="p-2">
              <div className="flex flex-wrap items-center gap-2">
                {/* Match this line to an invoice the customer still owes. */}
                <form action="/api/v1/accounting/reconcile" method="post" className="flex items-center gap-1">
                  <input type="hidden" name="bankTxId" value={r.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <label className="flex items-center">
                    <span className="sr-only">Invoice to match &ldquo;{r.description}&rdquo; against</span>
                    <select
                      name="invoiceId"
                      required
                      defaultValue=""
                      className="max-w-[16rem] rounded border px-1 py-1 text-sm"
                    >
                      <option value="">Choose an invoice…</option>
                      {invoices.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.number ? `${inv.number} — ` : ''}
                          {fmtPence(outstandingPence(inv).toString())} outstanding
                          {inv.issued_on ? ` (${inv.issued_on.slice(0, 10)})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button name="action" value="match" className="px-2 py-1 text-sm border rounded">
                    Match
                  </button>
                </form>

                {/* Categorise it without touching an invoice. */}
                <form action="/api/v1/accounting/reconcile" method="post" className="flex items-center gap-1">
                  <input type="hidden" name="bankTxId" value={r.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button name="action" value="vat" className="px-2 py-1 text-sm border rounded">
                    VAT payment
                  </button>
                  <button name="action" value="fee" className="px-2 py-1 text-sm border rounded">
                    Bank fee
                  </button>
                  <button name="action" value="ignore" className="px-2 py-1 text-sm border rounded">
                    Ignore
                  </button>
                </form>
              </div>
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={5} className="p-4 text-gray-500">
              Queue empty — every bank transaction has been categorised.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
