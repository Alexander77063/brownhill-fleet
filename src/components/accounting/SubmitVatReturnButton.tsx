'use client';

// src/components/accounting/SubmitVatReturnButton.tsx
// The button that files a VAT return with HMRC.
//
// WHY THIS IS A CLIENT COMPONENT
// ------------------------------
// The button used to be a plain HTML form that POSTed to the submit route,
// and the route answered with a redirect. The route now answers with JSON —
// what HMRC said, whether it took it, and the reference to quote — because
// "the return was filed" and "HMRC refused the return" are very different
// things to tell an operator, and a redirect to a page that says "submitted"
// can only ever say the first one.
//
// Which is the whole point. The old route answered "submitted" to everything,
// because the function underneath it never called HMRC.
//
// WHAT IT SHOWS
// -------------
//   * while it is filing — so the operator does not press it twice
//   * on success — HMRC's own correlation id, which is the reference to quote
//     to HMRC if anything is wrong with the return
//   * on refusal — HMRC's own words, which are the only thing that tells the
//     operator what to change
//
// A return HMRC has accepted cannot be taken back, so the button is disabled
// once a return has been filed for the period: pressing it again would file
// a second return for the same period.
//
// THE TWO 409s
// ------------
// Filing the same period twice is refused, and the two refusals mean
// different things to the operator:
//
//   * 'already_filed' — HMRC has this return. There is nothing to do. Filing
//     it again would be a duplicate return at HMRC and a second posting in
//     the books.
//   * 'filing_in_progress' — either the filing is still running, or it
//     started and never finished. Only the second can be taken over, and
//     only deliberately: an attempt that died may have reached HMRC, so the
//     operator is asked to check HMRC's filing history first.

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export interface SubmitVatReturnButtonProps {
  year: number;
  month: number;
}

/** What the button is doing. */
type Phase = 'idle' | 'submitting' | 'submitted' | 'failed';

/** The body the submit route answers with. */
interface SubmitBody {
  error?: string;
  correlationId?: string;
  code?: string;
  canForce?: boolean;
}

export default function SubmitVatReturnButton({ year, month }: SubmitVatReturnButtonProps) {
  const router = useRouter();
  const period = `${year}-${String(month).padStart(2, '0')}`;

  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  // True only when a filing died without an answer — the one case where the
  // operator may deliberately take over.
  const [canForce, setCanForce] = useState(false);

  const submit = useCallback(
    async (force = false) => {
      setPhase('submitting');
      setMessage(null);
      setReference(null);

      try {
        const res = await fetch(
          `/api/v1/accounting/mtd/submit?period=${period}${force ? '&force=1' : ''}`,
          { method: 'POST' },
        );
        // The body is JSON on every path this route produces, but a proxy or a
        // crash can produce something else — and a parse failure must not turn
        // into an unhandled rejection that leaves the button spinning forever.
        const json = (await res.json().catch(() => ({}))) as SubmitBody;

        if (res.ok) {
          setPhase('submitted');
          setReference(json.correlationId ?? null);
          setCanForce(false);
          router.refresh();
          return;
        }

        setPhase('failed');
        setMessage(json.error ?? 'The return could not be filed.');
        setCanForce(res.status === 409 && json.code === 'filing_in_progress' && json.canForce === true);
      } catch {
        setPhase('failed');
        setMessage('Could not reach the server. The return was not filed — try again.');
        setCanForce(false);
      }
    },
    [period, router],
  );

  if (phase === 'submitted') {
    return (
      <div>
        <p
          role="status"
          className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface)] p-3 text-sm text-cream"
        >
          The VAT return for {period} was filed with HMRC.
          {reference && (
            <>
              {' '}
              Their reference is <span className="font-mono">{reference}</span> — quote it if you
              need to ask HMRC about this return.
            </>
          )}
        </p>
        <p className="mt-2 text-sm text-muted">
          A return HMRC has accepted cannot be withdrawn. To correct it, file an adjustment
          return with HMRC.
        </p>
      </div>
    );
  }

  return (
    <div>
      {phase === 'failed' && message && (
        <p
          role="alert"
          className="mb-3 rounded-[var(--radius)] border border-[var(--color-loss)] p-3 text-sm text-[var(--color-loss)]"
        >
          {message}
        </p>
      )}
      <Button
        type="button"
        variant="primary"
        size="md"
        onClick={() => submit(false)}
        disabled={phase === 'submitting'}
      >
        {phase === 'submitting' ? 'Filing with HMRC…' : 'Submit to HMRC'}
      </Button>
      {canForce && (
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => submit(true)}
            disabled={phase === 'submitting'}
          >
            File it again
          </Button>
          <p className="mt-1 text-sm text-muted">
            Only do this once you have checked HMRC&rsquo;s filing history for {period}. If HMRC
            never received the earlier attempt, this files it for the first time.
          </p>
        </div>
      )}
    </div>
  );
}
