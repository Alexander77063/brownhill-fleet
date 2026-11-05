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

export function OverdueCheckCard({ appUrl }: { appUrl: string | null }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: RunOverdueCheckResult) => runOverdueCheckAction(),
    initial,
  );

  // The command has to name THIS box. It used to name one particular
  // deployment, so an operator running it on any other box — including the one
  // it was copied from — called the wrong host, and the check silently did
  // nothing. When the install does not know its own address the command
  // carries a placeholder and says so, which is the honest thing to print.
  const target = appUrl ?? '<this box\'s address>';

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
        {/*
          `break-all` is what keeps this page inside 320 CSS px. The command is one
          unbroken run of characters — a cron expression, two flags, a header and a
          URL — and a single unbreakable word in it pushed the whole page wider
          than the viewport, which is a WCAG 1.4.10 Reflow failure. The runtime
          accessibility pass caught it on /ops/billing at 320 px.
        */}
        <code className="ml-1 break-all rounded bg-[rgba(0,0,0,0.35)] px-1 py-0.5">
          17 9 * * * curl -fsS -X POST -H 'authorization: Bearer $OPS_TOKEN' {target}/api/automation/rent-overdue
        </code>
        runs the same check at 09:17 every day, once you have an automation token wired up.
      </p>
      {!appUrl && (
        <p className="mt-2 text-xs text-muted">
          This installation does not know its own public address, so the command above carries a
          placeholder. Set <code>NEXT_PUBLIC_APP_URL</code> in the app environment and restart it,
          and the address will be filled in for you.
        </p>
      )}
    </div>
  );
}
