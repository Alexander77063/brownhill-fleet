// src/components/accounting/InvoiceRegister.tsx
// The invoice register, shared by the two consoles that host it
// (/accounts/accounting/invoices for the accountant,
// /admin/accounting/invoices for the operator).
//
// WHY IT EXISTS
// -------------
// The product had no invoice list. An invoice was visible only in the
// reconciliation queue's match picker — which shows the invoices a bank line
// can still be matched to, and nothing else — and in the reports, which are
// summaries and not a working list.
//
// So "which invoices have we issued, which are still owed, and what is this
// one for?" had no answer anywhere in the product. This table is that
// answer, and it is also the surface the void lives on: a correction the
// operator cannot see is a correction nobody performs.
//
// ONE TABLE, TWO CONSOLES
// -----------------------
// The reconcile queue already established the pattern: the table lives in
// one component and each console supplies its own data and its own
// permission gate. Two copies of a money table is two copies to fix.
//
// THE COLUMNS
// -----------
// Every column is a question somebody asks out loud. Who is it for (the
// customer and the vehicle — an invoice with no vehicle behind it is the
// one that was raised against the wrong car). How much (gross, and the VAT
// inside it). What has been received. What is still owed. When it is due,
// and when it was issued.
//
// The status column is the invoice's own, and 'void' is one of them: a
// voided invoice stays in the register, marked, rather than disappearing.
// Hiding it would be worse than showing it — the operator needs to see that
// it was cancelled, and why the money is not there.

import Link from 'next/link';
import { Badge, Table, Th, Td, EmptyState } from '@/components/ui';
import { VoidInvoiceButton } from '@/components/accounting/VoidInvoiceButton';
// From ./invoice-shared, not from ./invoice-register: this component renders
// the client-side Void control, and the register module reaches the database
// behind `import 'server-only'`.
import {
  formatPence,
  outstandingPence,
  type InvoiceRegisterRow,
  type InvoiceStatus,
} from '@/lib/accounting/invoice-shared';

export interface InvoiceRegisterProps {
  rows: InvoiceRegisterRow[];
  /** Whether the signed-in user may void. The server decides; this only draws. */
  canVoid: boolean;
  /** How many invoices the tenant has in each status. */
  counts: Record<InvoiceStatus, number>;
  /** The status being viewed. */
  activeStatus: InvoiceStatus | 'all';
  /** The path the filter links point at, so each console keeps its own URL. */
  basePath: string;
}

/** The badge tone for an invoice status. */
function statusTone(status: string): 'neutral' | 'info' | 'warn' | 'profit' | 'loss' {
  switch (status) {
    case 'paid':
      return 'profit';
    case 'part_paid':
      return 'warn';
    case 'overdue':
      return 'loss';
    case 'open':
      return 'info';
    default:
      return 'neutral';
  }
}

/** 'open' → 'Open'. */
function statusLabel(status: string): string {
  return status.replace('_', ' ');
}

/** The status filter, and the number behind each one. */
const FILTERS: Array<{ key: InvoiceStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'part_paid', label: 'Part paid' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
];

export function InvoiceRegister({
  rows,
  canVoid,
  counts,
  activeStatus,
  basePath,
}: InvoiceRegisterProps) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <>
      <nav aria-label="Filter invoices by status" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const n = filter.key === 'all' ? total : counts[filter.key];
          const active = activeStatus === filter.key;
          return (
            <Link
              key={filter.key}
              href={filter.key === 'all' ? basePath : `${basePath}?status=${filter.key}`}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded-full border border-[var(--color-gold)] bg-[rgba(184,151,42,0.12)] px-3 py-1 text-xs font-semibold text-gold-bright'
                  : 'rounded-full border border-hair-soft px-3 py-1 text-xs text-parchment hover:border-hair hover:text-cream'
              }
            >
              {filter.label} <span className="tnum">{n}</span>
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          title="No invoices here"
          hint="Invoices are raised by the rent schedule and appear here as soon as they are issued."
        />
      ) : (
        <Table caption="Invoices issued, with what has been received against each one">
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Customer</Th>
              <Th>Vehicle</Th>
              <Th>Issued</Th>
              <Th>Due</Th>
              <Th className="text-right">Gross</Th>
              <Th className="text-right">VAT</Th>
              <Th className="text-right">Received</Th>
              <Th className="text-right">Outstanding</Th>
              <Th>Status</Th>
              {canVoid && <Th>Action</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const outstanding = outstandingPence(row);
              const voidable = canVoid && row.status !== 'void';
              return (
                <tr key={row.id}>
                  <Td className="font-mono text-xs">{row.number ?? '—'}</Td>
                  <Td>{row.customer_name ?? '—'}</Td>
                  <Td className="font-mono text-xs">{row.vehicle_registration ?? '—'}</Td>
                  <Td className="tnum">{row.issued_on}</Td>
                  <Td className="tnum">{row.due_on}</Td>
                  <Td className="tnum text-right">{formatPence(row.gross_pence)}</Td>
                  <Td className="tnum text-right">{formatPence(row.vat_pence)}</Td>
                  <Td className="tnum text-right">{formatPence(row.allocated_pence)}</Td>
                  <Td className="tnum text-right">
                    {row.status === 'void' ? '—' : formatPence(outstanding)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                  </Td>
                  {canVoid && (
                    <Td>
                      {voidable ? (
                        <VoidInvoiceButton
                          invoiceId={row.id}
                          number={row.number}
                          customerName={row.customer_name}
                          grossPence={row.gross_pence}
                          allocatedPence={row.allocated_pence}
                          issuedOn={row.issued_on}
                        />
                      ) : (
                        <span className="text-xs text-muted">Cancelled</span>
                      )}
                    </Td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}
