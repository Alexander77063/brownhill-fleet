'use client';

import { useState } from 'react';
import { Card, CardTitle, Badge, Button } from '@/components/ui';
import { Icon } from '@/components/icons';
import type { SigningRow } from '@/lib/actions/signing';

const STATUS_LABEL: Record<string, string> = {
  partner_review: 'Partner reviewing',
  driver_sign: 'Awaiting driver',
  signed: 'Signed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};
const STATUS_TONE: Record<string, 'gold' | 'profit' | 'loss' | 'neutral'> = {
  partner_review: 'gold',
  driver_sign: 'gold',
  signed: 'profit',
  declined: 'loss',
  cancelled: 'neutral',
};

export function SigningPanel({
  agreementId,
  sessions,
  onSend,
}: {
  agreementId: string;
  sessions: SigningRow[];
  onSend: (formData: FormData) => Promise<void>;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Signing</CardTitle>
        <form action={onSend}>
          <input type="hidden" name="agreement_id" value={agreementId} />
          <Button type="submit" variant="outline" size="sm">
            <Icon name="signature" className="h-4 w-4" /> Send for signature
          </Button>
        </form>
      </div>

      {sessions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          No signing sessions yet. “Send for signature” creates a link your partner opens to confirm the
          terms, then hands to the driver to sign.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {sessions.map((s) => (
            <li key={s.id} className="border-t border-hair-soft pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-parchment">{s.reference}</span>
                <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
              </div>
              {s.status === 'partner_review' && <CopyRow label="Partner link" url={s.partner_link} />}
              {s.status === 'driver_sign' && (
                <p className="mt-1 text-xs text-muted">Partner {s.partner_name} approved — driver to sign.</p>
              )}
              {s.status === 'signed' && (
                <p className="mt-1 text-xs text-[var(--color-profit)]">
                  Signed by {s.driver_name}
                  {s.driver_signed_at ? ` · ${new Date(s.driver_signed_at).toLocaleDateString('en-GB')}` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CopyRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.target.select()}
        aria-label={label}
        className="flex-1 rounded-md border border-hair bg-[var(--surface-soft)] px-2 py-1.5 font-mono text-[11px] text-parchment"
      />
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="rounded-md border border-hair px-3 py-1.5 text-xs font-semibold text-gold-bright hover:bg-[rgba(184,151,42,0.08)]"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
