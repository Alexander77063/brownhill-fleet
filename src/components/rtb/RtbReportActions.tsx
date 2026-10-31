'use client';

/**
 * Download and email the rent-to-buy report.
 *
 * The downloads are plain links to the report route — the browser handles the
 * file, the server never has to guess a filename. The email goes through a
 * server action so the sender sees what happened ("sent 4, 1 skipped") rather
 * than a page that silently did nothing.
 *
 * Sending is the board's job, so the email controls are only rendered for
 * callers who may send: an investor reads the report in their portal and
 * downloads it, but does not get to mail the business's figures elsewhere.
 */

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { sendRtbReportAction } from '@/lib/actions/reports';

export function RtbReportActions({
  audience,
  /** Who the report is for, in the words shown on the buttons. */
  label,
  canSend = true,
}: {
  audience: 'board' | 'investor';
  label?: string;
  canSend?: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [to, setTo] = useState('');

  const audienceParam = audience === 'investor' ? 'investor' : 'board';
  const base = `/api/reports/rent-to-buy?audience=${audienceParam}`;

  function send() {
    setResult(null);
    start(async () => {
      const form = new FormData();
      form.set('audience', audienceParam);
      if (to.trim()) form.set('to', to.trim());
      const res = await sendRtbReportAction(form);
      const parts: string[] = [];
      if (res.message) parts.push(res.message);
      for (const s of res.skipped ?? []) parts.push(`Skipped ${s.reason}`);
      for (const f of res.failed ?? []) parts.push(`Failed ${f.error}`);
      setResult({
        tone: res.ok ? 'ok' : 'bad',
        text: parts.join(' ') || (res.ok ? 'Sent.' : 'The report could not be sent.'),
      });
      if (res.ok) setTo('');
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" href={`${base}&format=html`} target="_blank" prefetch={false}>
          Open {label ?? 'report'} (print / PDF)
        </Button>
        <Button variant="outline" size="sm" href={`${base}&format=csv`} prefetch={false}>
          Download CSV
        </Button>
      </div>

      {canSend && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-muted">
              Also send to (optional) — comma-separated addresses
            </span>
            <input
              type="text"
              name="to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="finance@brownhill.co.uk"
              className="rounded-[var(--radius)] border border-hair bg-surface px-3 py-2 text-sm text-cream"
            />
          </label>
          <Button size="sm" onClick={send} disabled={pending}>
            {pending ? 'Sending…' : 'Send by email'}
          </Button>
        </div>
      )}

      {result && (
        <p className={`text-xs ${result.tone === 'ok' ? 'text-[var(--color-profit)]' : 'text-[var(--color-loss)]'}`}>
          {result.text}
        </p>
      )}
    </div>
  );
}
