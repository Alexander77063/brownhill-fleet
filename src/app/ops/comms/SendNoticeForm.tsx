'use client';

// /ops/comms/SendNoticeForm — Client Component that drives the comms server
// action via useFormState and surfaces the per-recipient send log. The form
// is intentionally narrow: recipient kind + scope (single/all) + an
// optional id + subject + body. Anything more elaborate (template macros,
// scheduling) is a future feature.

import { useActionState } from 'react';
import { Button } from '@/components/ui';
import {
  sendNoticeAction,
  type SendNoticeResult,
} from '@/lib/actions/comms-notice';

const initial: SendNoticeResult = { ok: false };

const inputCls =
  'mt-1 w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';
const labelCls = 'eyebrow text-parchment';

export interface RecipientOption {
  id: string;
  label: string;
  has_email: boolean;
  has_phone: boolean;
}

export function SendNoticeForm({
  drivers,
  owners,
}: {
  drivers: RecipientOption[];
  owners: RecipientOption[];
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: SendNoticeResult, fd: FormData) => sendNoticeAction(fd),
    initial,
  );

  return (
    <form action={formAction} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className={labelCls}>Recipient</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2">
            <input type="radio" name="kind" value="driver_single" defaultChecked />
            <span className="text-sm text-cream">One driver</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="kind" value="driver_all" />
            <span className="text-sm text-cream">All drivers</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="kind" value="owner_single" />
            <span className="text-sm text-cream">One vehicle owner</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="kind" value="owner_all" />
            <span className="text-sm text-cream">All vehicle owners</span>
          </label>
        </div>
      </fieldset>

      <div>
        <label className={labelCls} htmlFor="recipient-id">Recipient id (only for *single kinds)</label>
        <input
          id="recipient-id"
          name="recipient_id"
          className={inputCls}
          placeholder="uuid of the driver or owner"
        />
        <p className="mt-1 text-xs text-muted">
          Leave blank when sending to <em>all</em>. We’ll send to every active record whose profile has an email or phone.
        </p>
      </div>

      <div>
        <label className={labelCls} htmlFor="notice-subject">Subject</label>
        <input
          id="notice-subject"
          name="subject"
          required
          className={inputCls}
          placeholder="Rent overdue — please review"
        />
      </div>
      <div>
        <label className={labelCls} htmlFor="notice-body">Message</label>
        <textarea
          id="notice-body"
          name="body"
          required
          rows={5}
          className={inputCls}
          placeholder="Plain text. We wrap it in a simple HTML body before sending."
        />
      </div>

      {state.error ? (
        <p role="alert" className="rounded-md border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]">
          {state.message ?? state.error}
        </p>
      ) : state.ok ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-[var(--color-profit)] bg-[rgba(45,168,98,0.10)] px-3 py-2 text-sm"
        >
          <p className="text-[var(--color-profit)] font-medium">
            Sent to {state.sent}/{state.targets} recipient{state.targets === 1 ? '' : 's'}.
          </p>
          {state.skipped && state.skipped.length > 0 && (
            <p className="mt-1 text-cream">
              {state.skipped.length} had no email or phone on file and were skipped:
            </p>
          )}
          {state.skipped && state.skipped.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs text-muted">
              {state.skipped.map((s) => (
                <li key={s.id}>
                  {s.label} <span className="text-muted">({s.id})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send notice'}
        </Button>
      </div>

      <details className="text-xs text-muted">
        <summary>Who will receive this?</summary>
        <ul className="mt-1 ml-4 list-disc">
          {drivers.map((d) => (
            <li key={d.id}>
              driver · {d.label} {!d.has_email && !d.has_phone && <span className="text-amber-300">(no channels)</span>}
            </li>
          ))}
          {owners.map((o) => (
            <li key={o.id}>
              owner · {o.label} {!o.has_email && !o.has_phone && <span className="text-amber-300">(no channels)</span>}
            </li>
          ))}
        </ul>
      </details>
    </form>
  );
}
