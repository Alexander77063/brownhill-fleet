'use client';

// /ops/billing/OverdueCheckCard — small Client Component that drives
// runOverdueCheckAction via useFormState so ops sees the result of
// their last run (sent / skipped / failed) without a separate request.

import { useActionState } from 'react';
import { Button, CardTitle } from '@/components/ui';
import {
  runOverdueCheckAction,
  type RunOverdueCheckResult,
} from '@/lib/actions/run-overdue-check';

const initial: RunOverdueCheckResult = { ok: false, scanned: 0, sent: 0, skipped: 0, failed: 0 };

export function OverdueCheckCard() {
  const [state, formAction, pending] = useActionState(
    async (_prev: RunOverdueCheckResult) => runOverdueCheckAction(),
    initial,
  );

  return (
    <div className="rounded-[var(--radius)] border border-hair-soft bg-[rgba(255,255,255,0.03)] p-5 reveal">
      <CardTitle>Rent-overdue check</CardTitle>
      <p className="mt-1 text-sm text-muted">
        Sends a one-shot email + SMS to every driver with an invoice past its
        due date. Each invoice is only notified once (dedup key
        <code>rent_overdue:&lt;invoice_id&gt;</code>); run again tomorrow to
        pick up new overdue ones.
      </p>

      <form action={formAction} className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Run overdue check now'}
        </Button>
        {state.ok && (
          <span className="text-sm text-cream">
            Scanned <strong>{state.scanned}</strong> · sent{' '}
            <strong className="text-[var(--color-profit)]">{state.sent}</strong>
            {state.skipped > 0 && (
              <>
                {' '}· skipped <strong className="text-amber-300">{state.skipped}</strong>
              </>
            )}
            {state.failed > 0 && (
              <>
                {' '}· failed <strong className="text-[var(--color-loss)]">{state.failed}</strong>
              </>
            )}
          </span>
        )}
        {state.error && (
          <span className="text-sm text-[var(--color-loss)]">{state.error}</span>
        )}
      </form>

      <p className="mt-3 text-xs text-muted">
        Tip: a daily system cron entry like
        <code className="ml-1 rounded bg-[rgba(0,0,0,0.35)] px-1 py-0.5">
          17 9 * * * curl -fsS -X POST -H 'authorization: Bearer $OPS_TOKEN' https://brownhillmanagementfleet.online/api/automation/rent-overdue
        </code>
        runs the same check at 09:17 every day, once you have an automation token wired up.
      </p>
    </div>
  );
}
