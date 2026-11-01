'use client';

// src/components/accounting/ClosePeriodButton.tsx
// The Close control on the periods pages.
//
// WHY THIS EXISTS
// ---------------
// The Close button closed a month with one click and no warning. The spec
// asks for "Close period (warns: locks all postings; shows affected counts;
// confirm modal)" — nothing warned, nothing counted, and nothing confirmed,
// so an operator closing October with uncategorised bank lines and an unfiled
// VAT return found out afterwards, when a posting came back 409 and the
// month was already shut.
//
// The flow
// --------
// 1. The operator presses Close. The dialog opens and asks the server what
//    closing this period would do. The server answers 428 (Precondition
//    Required) with the counts and the warnings — nothing is closed yet.
// 2. The operator reads the warnings and ticks each one. A warning they have
//    not seen is a warning they have not acknowledged.
// 3. The operator confirms. The server closes the period, or answers 428
//    again — because a bank line landed while the dialog was open and there
//    is now a warning that was not on screen when they ticked the boxes.
//    That warning is shown, unticked, and the confirm button stays disabled
//    until it is acknowledged.
//
// The server is the authority on all of this. The disabled button is a
// courtesy, not the gate: the route refuses a close whose warning list is
// not fully acknowledged, so a client that lies about it gains nothing.

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@/components/ui';
import { formatGBP } from '@/lib/money';
import type { ClosePreflight, CloseWarningCode } from '@/lib/accounting/close-preflight';
import {
  closeConfirmRequest,
  closePreflightRequest,
  type CloseConfirmRequest,
  type ClosePreflightRequest,
} from '@/lib/accounting/close-request';

export interface ClosePeriodButtonProps {
  year: number;
  month: number;
}

/** What the dialog is doing. */
type Phase = 'idle' | 'loading' | 'ready' | 'closing' | 'failed';

export function ClosePeriodButton({ year, month }: ClosePeriodButtonProps) {
  const router = useRouter();
  const period = `${year}-${String(month).padStart(2, '0')}`;

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [preflight, setPreflight] = useState<ClosePreflight | null>(null);
  const [acknowledged, setAcknowledged] = useState<CloseWarningCode[]>([]);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(async (body: ClosePreflightRequest | CloseConfirmRequest) => {
    const res = await fetch('/api/v1/accounting/periods/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // The body is JSON on every path this route produces, but a proxy or a
    // crash can produce something else — and a parse failure must not turn
    // into an unhandled rejection that leaves the dialog spinning forever.
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      preflight?: ClosePreflight;
    };
    return { res, json };
  }, []);

  /** Open the dialog and ask the server what closing this period would do. */
  const openDialog = useCallback(async () => {
    setOpen(true);
    setPhase('loading');
    setError(null);
    setPreflight(null);
    setAcknowledged([]);

    const { res, json } = await post(closePreflightRequest(period));
    if (res.status === 428 && json.preflight) {
      setPreflight(json.preflight);
      setPhase('ready');
      return;
    }
    if (res.ok) {
      // The route only closes with a confirmation, so a bare 200 here means
      // the period was already closed and something is out of step. Refresh
      // and let the table tell the truth.
      setOpen(false);
      router.refresh();
      return;
    }
    setError(json.error ?? 'Could not read the period.');
    setPhase('failed');
  }, [period, post, router]);

  /** Close it, with the warnings the operator has acknowledged. */
  const confirm = useCallback(async () => {
    setPhase('closing');
    setError(null);

    // The route reads the list under the key `acknowledge`; the state that
    // holds it is called `acknowledged`. The body is built in one place —
    // `closeConfirmRequest` — so the two cannot drift apart again.
    const { res, json } = await post(closeConfirmRequest(period, acknowledged));
    if (res.ok) {
      setOpen(false);
      router.refresh();
      return;
    }
    if (res.status === 428 && json.preflight) {
      // Something changed while the dialog was open — a bank line landed.
      // The new warning is shown unticked; the ones already ticked stay
      // ticked, because the operator has seen those.
      setPreflight(json.preflight);
      setPhase('ready');
      return;
    }
    setError(json.error ?? 'Could not close this period.');
    setPhase('failed');
  }, [period, acknowledged, post, router]);

  const toggleAcknowledged = (code: CloseWarningCode, on: boolean) => {
    setAcknowledged((current) =>
      on ? (current.includes(code) ? current : [...current, code]) : current.filter((c) => c !== code),
    );
  };

  const counts = preflight?.counts ?? null;
  const outstanding = preflight?.warnings.filter((w) => !acknowledged.includes(w.code)) ?? [];
  const canConfirm = phase === 'ready' && outstanding.length === 0;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={openDialog}>
        Close
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Close ${period}`}
        description="Closing a period stops anything being posted into it. You can reopen it for a short window afterwards if you need to."
        footer={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={confirm} disabled={!canConfirm}>
              {phase === 'closing' ? 'Closing…' : `Close ${period}`}
            </Button>
          </>
        }
      >
        {error && (
          <p role="alert" className="mb-4 rounded border border-[var(--color-loss)] p-3 text-sm text-[var(--color-loss)]">
            {error}
          </p>
        )}

        {phase === 'loading' && <p className="text-sm text-muted">Reading the period…</p>}

        {counts && (
          <dl className="mb-4 space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-parchment">Postings in this period</dt>
              <dd className="tnum text-cream">{counts.journalEntries}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-parchment">Open bank transactions</dt>
              <dd className="tnum text-cream">
                {counts.openBankItems}
                {counts.openBankItems > 0 && ` · ${formatGBP(counts.openBankItemsPence)}`}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-parchment">Invoices still owed</dt>
              <dd className="tnum text-cream">
                {counts.openInvoices}
                {counts.openInvoices > 0 && ` · ${formatGBP(counts.openInvoicesPence)}`}
              </dd>
            </div>
            {counts.netVatPence !== 0 && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-parchment">Net VAT for the period</dt>
                <dd className="tnum text-cream">{formatGBP(counts.netVatPence)}</dd>
              </div>
            )}
          </dl>
        )}

        {preflight && preflight.warnings.length > 0 && (
          <div className="space-y-3">
            {preflight.warnings.map((warning) => (
              <div key={warning.code} className="rounded border border-hair bg-[var(--surface)] p-3">
                <p className="text-sm text-cream">{warning.message}</p>
                <label className="mt-2 flex items-start gap-2 text-sm text-parchment">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acknowledged.includes(warning.code)}
                    onChange={(event) => toggleAcknowledged(warning.code, event.target.checked)}
                  />
                  <span>I have read this and still want to close the period.</span>
                </label>
              </div>
            ))}
          </div>
        )}

        {preflight && preflight.warnings.length === 0 && (
          <p className="text-sm text-muted">
            Nothing is outstanding for this period. Closing it will stop any further postings into {period}.
          </p>
        )}
      </Dialog>
    </>
  );
}
