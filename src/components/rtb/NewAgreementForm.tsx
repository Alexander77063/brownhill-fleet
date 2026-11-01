'use client';

/**
 * The "New agreement" form.
 *
 * A client component because the form has two shapes: a standard rental is
 * priced weekly, and a rent-to-buy is priced monthly and billed weekly. The
 * rent-to-buy branch hands over to the calculator, which owns the deal
 * figures and shows the operator what the deal costs the rentee and what it
 * earns Brownhill before they commit to it.
 *
 * The vehicle select stays here in both branches: the calculator needs to
 * know which car is selected so it can fill the price from the car's list
 * value and the buyout price from its residual estimate.
 */

import { useState } from 'react';
import { createAgreement } from '@/lib/actions/ops';
import { RtbCalculator, type RtbVehicleOption } from './RtbCalculator';
import { Button } from '@/components/ui';

export interface AgreementDriverOption {
  id: string;
  full_name: string;
}

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export function NewAgreementForm({
  vehicles,
  drivers,
}: {
  vehicles: RtbVehicleOption[];
  drivers: AgreementDriverOption[];
}) {
  const [type, setType] = useState<'standard' | 'rtb'>('standard');
  const [vehicleId, setVehicleId] = useState('');

  return (
    <form action={createAgreement} className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-3">
        {/* These wrappers are <label> rather than <div>: the caption text was already
            visible, but only a real label associates it with the control for assistive
            tech (WCAG 1.3.1 / 4.1.2). Layout is unchanged. */}
        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Type</span>
          <select
            name="type"
            className={inputCls}
            value={type}
            onChange={(e) => setType(e.target.value === 'rtb' ? 'rtb' : 'standard')}
          >
            <option value="standard">Standard rental</option>
            <option value="rtb">Rent-to-buy</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Vehicle</span>
          <select
            name="vehicle_id"
            required
            className={inputCls}
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
          >
            <option value="" disabled>Select vehicle…</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Driver</span>
          <select name="driver_id" required className={inputCls} defaultValue="">
            <option value="" disabled>Select driver…</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Start date</span>
          <input type="date" name="start_date" className={inputCls} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Status</span>
          <select name="status" className={inputCls} defaultValue="active">
            <option value="active">Active</option>
            <option value="draft">Draft</option>
          </select>
        </label>

        {/* A standard rental is priced weekly. The rent-to-buy branch below
            prices monthly and derives the weekly rate itself. */}
        {type === 'standard' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-parchment">Weekly rate (£, inc VAT)</span>
              <input type="number" step="0.01" name="weekly_gross" placeholder="0.00" className={`${inputCls} tnum`} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-parchment">VAT rate</span>
              <select name="vat_rate" className={inputCls} defaultValue="20">
                <option value="20">20%</option>
                <option value="5">5%</option>
                <option value="0">0% / exempt</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-parchment">Deposit (£)</span>
              <input type="number" step="0.01" name="deposit" placeholder="0.00" className={`${inputCls} tnum`} />
            </label>
          </>
        )}
      </div>

      {type === 'rtb' && (
        <RtbCalculator variant="form" vehicles={vehicles} vehicleId={vehicleId} />
      )}

      <div className="flex w-full flex-col gap-2 pt-1">
        <p className="text-sm text-muted">
          {type === 'rtb'
            ? 'The rent-to-buy is priced monthly and billed weekly. The figures above become the agreement: the term, the deposit, the option credit and the buyout price are all saved with it.'
            : 'Rent-to-buy needs a term and weekly option credit. Set to Active to start weekly billing.'}
        </p>
        <div>
          <Button type="submit" variant="primary">Create agreement</Button>
        </div>
      </div>
    </form>
  );
}
