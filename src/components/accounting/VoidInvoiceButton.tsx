'use client';

// src/components/accounting/VoidInvoiceButton.tsx
// The Void control on the invoice register.
//
// WHY A DIALOG AND NOT A BUTTON
// -----------------------------
// Voiding an invoice is not a thing you can undo from this screen. It posts
// a reversal to the ledger, moves the month the invoice belongs to, and —
// if the customer has already paid — creates a refund the operator owes
// them. That is a decision, and a decision gets a confirmation that says
// what is about to happen.
//
// The dialog says the three things that decide whether the operator should
// press the button:
//
//   * WHICH invoice — by number, customer and amount, so nobody voids the
//     wrong row of a long list.
//   * WHICH month — the reversal goes into the invoice's own month, not
//     this one. If that month is closed, the void is refused and the
//     operator is told which month to reopen.
//   * WHAT IT COSTS — if the customer has already paid, the void creates a
//     refund for that amount. That is the number the operator is about to
//     owe, and it should not be a surprise discovered in the ledger.
//
// The reason box is optional but offered: "raised against the wrong car" is
// the kind of thing an accountant asks about six months later, and the
// answer is in the audit row.

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@/components/ui';
// From ./invoice-shared, NOT from ./invoice-register: the register module
// reaches the database, and the database connection is behind `import
// 'server-only'`. Importing it from a client component fails the build.
import { formatPence } from '@/lib/accounting/invoice-shared';

export interface VoidInvoiceButtonProps {
  invoiceId: string;
  /** The invoice number, for the operator to recognise it by. */
  number: string | null;
  customerName: string | null;
  grossPence: string;
  /** How much of it has been received — the refund it would create. */
  allocatedPence: string;
  /** The month the reversal will land in, 'YYYY-MM'. */
  issuedOn: string;
}

type Phase = 'idle' | 'voiding' | 'failed';

export function VoidInvoiceButton({
  invoiceId,
  number,
  customerName,
  grossPence,
  allocatedPence,
  issuedOn,
}: VoidInvoiceButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const gross = BigInt(grossPence || '0');
  const received = BigInt(allocatedPence || '0');
  const refund = received > 0n ? received : 0n;
  const month = issuedOn.slice(0, 7);

  const confirm = useCallback(async () => {
    setPhase('voiding');
    setError(null);
    try {
      const res = await fetch(`/api/v1/accounting/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        period?: string;
      };
      if (res.ok) {
        setOpen(false);
        setReason('');
        router.refresh();
        return;
      }
      // A closed period names the month, so say it here too rather than
      // leaving the operator to find it in the error text.
      setError(
        json.error && json.period
          ? `${json.error} (${json.period})`
          : (json.error ?? 'Could not void this invoice.'),
      );
      setPhase('failed');
    } catch {
      setError('Could not reach the server. Nothing has been changed.');
      setPhase('failed');
    }
  }, [invoiceId, reason, router]);

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Void
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (phase !== 'voiding') {
            setOpen(false);
            setError(null);
            setPhase('idle');
          }
        }}
        title="Void this invoice"
        description="Voiding cancels the invoice and posts a reversal to the ledger. It cannot be undone from this screen."
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={phase === 'voiding'}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={confirm}
              disabled={phase === 'voiding'}
            >
              {phase === 'voiding' ? 'Voiding…' : 'Void invoice'}
            </Button>
          </>
        }
      >
        {error && (
          <p
            role="alert"
            className="mb-4 rounded border border-[var(--color-loss)] p-3 text-sm text-[var(--color-loss)]"
          >
            {error}
          </p>
        )}

        <dl className="mb-4 space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-parchment">Invoice</dt>
            <dd className="text-cream">{number ?? '(no number)'}</dd>
          </div>
          {customerName && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-parchment">Customer</dt>
              <dd className="text-cream">{customerName}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-parchment">Amount</dt>
            <dd className="tnum text-cream">{formatPence(gross)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-parchment">Reversal goes into</dt>
            <dd className="tnum text-cream">{month}</dd>
          </div>
          {refund > 0n && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-parchment">Refund owed to the customer</dt>
              <dd className="tnum text-cream">{formatPence(refund)}</dd>
            </div>
          )}
        </dl>

        {refund > 0n && (
          <p className="mb-4 rounded border border-[var(--color-warn)] p-3 text-sm text-parchment">
            This invoice has been paid. Voiding it creates a refund of{' '}
            <span className="tnum">{formatPence(refund)}</span> that you still owe the customer.
          </p>
        )}

        <label className="block text-sm">
          <span className="text-parchment">Reason (optional)</span>
          <input
            type="text"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. raised against the wrong vehicle"
            className="mt-1 w-full rounded border border-hair bg-[var(--surface)] px-2 py-1.5 text-sm text-cream"
          />
        </label>
      </Dialog>
    </>
  );
}
