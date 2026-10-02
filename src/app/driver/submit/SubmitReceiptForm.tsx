'use client';

import { useActionState } from 'react';
import { Button, CardTitle } from '@/components/ui';
import { Icon } from '@/components/icons';
import { submitReceipt, type ActionResult } from '@/lib/actions/driver';

const initial: ActionResult | null = null;

interface Category {
  id: string;
  name: string;
  kind: 'expense' | 'charge';
}

export function SubmitReceiptForm({
  categories,
  vehicles,
}: {
  categories: Category[];
  vehicles: { id: string; registration: string }[];
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult | null, fd: FormData) => submitReceipt(fd),
    initial,
  );

  const field =
    'mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-[rgba(0,0,0,0.25)] px-3 py-2.5 text-sm text-cream placeholder:text-muted focus:border-[var(--color-gold)]';
  const label = 'eyebrow text-parchment';

  return (
    <form action={formAction} className="space-y-4">
      <CardTitle>Submit a receipt or charge</CardTitle>
      <p className="text-sm text-muted">
        Photograph a toll, congestion charge, PCN, fuel or parking receipt and send it to the office.
        It&apos;s linked to your vehicle and reviewed by your fleet team.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="category_id">Category</label>
          <select id="category_id" name="category_id" required className={field} defaultValue="">
            <option value="" disabled>Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        </div>
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
          <label className={label} htmlFor="amount">Amount (£)</label>
          <input id="amount" name="amount" inputMode="decimal" required placeholder="12.50" className={field} />
        </div>
        <div>
          <label className={label} htmlFor="incident_on">Date (optional)</label>
          <input id="incident_on" name="incident_on" type="date" className={field} />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="reference">Reference / notes (optional)</label>
        <input id="reference" name="reference" className={field} placeholder="PCN number, location…" />
      </div>

      <div>
        <label className={label} htmlFor="receipt">Photo</label>
        <input
          id="receipt"
          name="receipt"
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          className={`${field} file:mr-3 file:rounded file:border-0 file:bg-[rgba(184,151,42,0.15)] file:px-3 file:py-1 file:text-gold-bright`}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          <Icon name="upload" className="h-4 w-4" /> {pending ? 'Submitting…' : 'Submit to office'}
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
