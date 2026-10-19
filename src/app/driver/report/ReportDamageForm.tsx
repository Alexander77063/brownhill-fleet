'use client';

import { useActionState } from 'react';
import { Button, CardTitle } from '@/components/ui';
import { Icon } from '@/components/icons';
import { reportDamage, type ActionResult } from '@/lib/actions/driver';
import { SEVERITIES } from '@/lib/driver/damage-report-status';

const initial: ActionResult | null = null;

export function ReportDamageForm({
  vehicles,
}: {
  vehicles: { id: string; registration: string }[];
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult | null, fd: FormData) => reportDamage(fd),
    initial,
  );

  const field =
    'mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-[rgba(0,0,0,0.25)] px-3 py-2.5 text-sm text-cream placeholder:text-muted focus:border-[var(--color-gold)]';
  const label = 'eyebrow text-parchment';

  return (
    <form action={formAction} className="space-y-4">
      <CardTitle>New report</CardTitle>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="vehicle_id">Vehicle</label>
          <select id="vehicle_id" name="vehicle_id" required className={field} defaultValue="">
            <option value="" disabled>Choose…</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.registration}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="severity">Severity</label>
          <select id="severity" name="severity" required className={field} defaultValue="minor">
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="description">What happened</label>
        <textarea
          id="description"
          name="description"
          required
          minLength={10}
          maxLength={2000}
          rows={4}
          className={field}
          placeholder="Where on the vehicle, what you noticed, when it happened. At least 10 characters."
        />
      </div>

      <div>
        <label className={label} htmlFor="photo">Photo (optional)</label>
        <input
          id="photo"
          name="photo"
          type="file"
          accept="image/*"
          capture="environment"
          className={`${field} file:mr-3 file:rounded file:border-0 file:bg-[rgba(184,151,42,0.15)] file:px-3 file:py-1 file:text-gold-bright`}
        />
        <p className="mt-1 text-xs text-muted">A photo helps the office confirm the report.</p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          <Icon name="upload" className="h-4 w-4" /> {pending ? 'Sending…' : 'Send to office'}
        </Button>
        {state && (
          <p className={`text-sm ${state.ok ? 'text-[var(--color-profit)]' : 'text-[var(--color-loss)]'}`}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}