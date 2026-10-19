'use client';

// /ops/series/CreateSeriesForm — submits to createBookingSeries() and
// surfaces the success / error copy.

import { useActionState } from 'react';
import { Button, CardTitle } from '@/components/ui';
import { Icon } from '@/components/icons';
import { createBookingSeries, type CreateSeriesResult } from '@/lib/actions/booking-series';

const DAYS = [
  { v: 1, label: 'Mon' },
  { v: 2, label: 'Tue' },
  { v: 3, label: 'Wed' },
  { v: 4, label: 'Thu' },
  { v: 5, label: 'Fri' },
  { v: 6, label: 'Sat' },
  { v: 0, label: 'Sun' },
];

const initial: CreateSeriesResult | null = null;

export function CreateSeriesForm({
  drivers,
  vehicles,
}: {
  drivers: { id: string; full_name: string }[];
  vehicles: { id: string; registration: string }[];
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: CreateSeriesResult | null, fd: FormData) => createBookingSeries(fd),
    initial,
  );

  const field =
    'mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-[rgba(0,0,0,0.25)] px-3 py-2.5 text-sm text-cream placeholder:text-muted focus:border-[var(--color-gold)]';
  const label = 'eyebrow text-parchment';

  return (
    <form action={formAction} className="mt-3 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="pickup">Pickup</label>
          <input id="pickup" name="pickup" required className={field} placeholder="Heathrow T5" />
        </div>
        <div>
          <label className={label} htmlFor="dropoff">Dropoff</label>
          <input id="dropoff" name="dropoff" required className={field} placeholder="Central London" />
        </div>
        <div>
          <label className={label} htmlFor="start_time">Start time</label>
          <input id="start_time" name="start_time" type="time" required defaultValue="08:00" className={field} />
        </div>
        <div>
          <label className={label} htmlFor="fare">Fare £ (optional)</label>
          <input id="fare" name="fare" inputMode="decimal" className={field} placeholder="120.00" />
        </div>
        <div>
          <label className={label} htmlFor="driver_id">Driver (optional)</label>
          <select id="driver_id" name="driver_id" className={field} defaultValue="">
            <option value="">Unassigned</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="vehicle_id">Vehicle (optional)</label>
          <select id="vehicle_id" name="vehicle_id" className={field} defaultValue="">
            <option value="">Unassigned</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="start_date">Start date</label>
          <input id="start_date" name="start_date" type="date" required className={field} />
        </div>
        <div>
          <label className={label} htmlFor="end_date">End date (optional)</label>
          <input id="end_date" name="end_date" type="date" className={field} />
        </div>
        <div>
          <label className={label} htmlFor="horizon_weeks">Horizon weeks</label>
          <input id="horizon_weeks" name="horizon_weeks" type="number" min={1} max={52} defaultValue={4} className={field} />
        </div>
        <div>
          <label className={label} htmlFor="passenger_name">Passenger name</label>
          <input id="passenger_name" name="passenger_name" className={field} />
        </div>
      </div>

      <div>
        <span className={label}>Days of week</span>
        <div className="mt-2 flex flex-wrap gap-3">
          {DAYS.map((d) => (
            <label key={d.v} className="inline-flex items-center gap-1.5 rounded-md border border-hair-soft bg-[var(--surface-soft)] px-3 py-1.5 text-sm">
              <input type="checkbox" name="days_of_week" value={d.v} className="accent-[var(--color-gold)]" />
              <span className="text-cream">{d.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          <Icon name="plus" className="h-4 w-4" /> {pending ? 'Creating…' : 'Create series'}
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