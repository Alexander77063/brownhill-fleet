'use client';

/**
 * The rent-to-buy calculator.
 *
 * One component, two homes:
 *
 *   standalone — /ops/rtb-calculator. The whole thing: every input editable,
 *     three ways of asking the question (price the deal, solve the monthly
 *     payment, solve the buyout price), the cost to the rentee, the equity
 *     schedule, and what Brownhill makes on it.
 *
 *   form — inside the "New agreement" form. The same inputs, named so the
 *     browser submits them, with the headline figures beside them so the
 *     operator sees what they are committing to before they commit to it.
 *
 * The arithmetic is not here. It is in src/lib/rtb-calculator.ts, which the
 * server action also uses to write the agreement, so the figures on screen and
 * the figures in the database are computed by the same code.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  buildRtbPlan,
  solveBuyoutResidual,
  solveMonthlyPayment,
  type RtbInputs,
  type RtbPlan,
} from '@/lib/rtb-calculator';
import { formatGBP } from '@/lib/money';
import { Card, CardTitle, Money, Stat, Table, Th, Td, Badge } from '@/components/ui';

export interface RtbVehicleOption {
  id: string;
  registration: string;
  list_value_pence: number | null;
  /** The company's estimate of what the car is worth at the end of the term. */
  residual_estimate_pence?: number | null;
}

/** The figures as typed. Kept as strings so a half-typed number is not fought with. */
export interface RtbFormValues {
  vehiclePrice: string;
  deposit: string;
  termMonths: string;
  monthlyPayment: string;
  vatRate: string;
  optionCredit: string;
  agreedResidual: string;
  vehicleCost: string;
  targetApr: string;
}

export type RtbMode = 'price' | 'payment' | 'buyout';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

/** £ in the box, pence in the engine. */
function toPence(value: string): number {
  const n = Number.parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function toInputs(v: RtbFormValues): RtbInputs {
  const cost = toPence(v.vehicleCost);
  return {
    vehiclePricePence: toPence(v.vehiclePrice),
    depositPence: toPence(v.deposit),
    termMonths: Number.parseInt(v.termMonths, 10) || 0,
    monthlyPaymentPence: toPence(v.monthlyPayment),
    vatRatePct: Number.parseFloat(v.vatRate) || 0,
    optionCreditMonthlyPence: toPence(v.optionCredit),
    agreedResidualPence: toPence(v.agreedResidual),
    vehicleCostPence: cost > 0 ? cost : undefined,
  };
}

/** The figures the deal starts from — the example the calculator was asked for. */
export const RTB_DEFAULTS: RtbFormValues = {
  vehiclePrice: '30000',
  deposit: '10000',
  termMonths: '60',
  monthlyPayment: '750',
  vatRate: '20',
  optionCredit: '100',
  agreedResidual: '20000',
  vehicleCost: '',
  targetApr: '',
};

function pct(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

function money(pence: number): string {
  return formatGBP(pence, { showPence: false });
}

/* ── The calculator ──────────────────────────────────────────────────────── */

export function RtbCalculator({
  variant = 'standalone',
  vehicles,
  vehicleId,
  initial,
}: {
  variant?: 'standalone' | 'form';
  /** The fleet, so the car's price can be filled in from its list value. */
  vehicles?: RtbVehicleOption[];
  /** The vehicle chosen in the parent form (form variant). */
  vehicleId?: string;
  /** Starting figures. */
  initial?: Partial<RtbFormValues>;
}) {
  const [values, setValues] = useState<RtbFormValues>({ ...RTB_DEFAULTS, ...initial });
  const [mode, setMode] = useState<RtbMode>('price');
  const [ownVehicleId, setOwnVehicleId] = useState('');
  const [stepMonths, setStepMonths] = useState(12);

  // In the form the parent owns the vehicle selection; standalone the
  // calculator owns it.
  const selectedVehicleId = variant === 'form' ? (vehicleId ?? '') : ownVehicleId;
  const set = (patch: Partial<RtbFormValues>) => setValues((v) => ({ ...v, ...patch }));

  // Filling the price from the car's list value, and the buyout price from
  // the residual estimate the fleet record carries. The operator can still
  // edit either afterwards — this only sets them when the vehicle changes.
  useEffect(() => {
    const vehicle = vehicles?.find((v) => v.id === selectedVehicleId);
    if (!vehicle || !vehicle.list_value_pence) return;
    const price = (vehicle.list_value_pence / 100).toFixed(2);
    setValues((v) => ({
      ...v,
      vehiclePrice: price,
      vehicleCost: v.vehicleCost || price,
      agreedResidual: vehicle.residual_estimate_pence
        ? (vehicle.residual_estimate_pence / 100).toFixed(2)
        : v.agreedResidual,
    }));
  }, [selectedVehicleId, vehicles]);

  const inputs = useMemo(() => toInputs(values), [values]);

  const solved = useMemo(() => {
    const target = Number.parseFloat(values.targetApr);
    if (mode === 'payment' && Number.isFinite(target)) return solveMonthlyPayment(inputs, target);
    if (mode === 'buyout' && Number.isFinite(target)) return solveBuyoutResidual(inputs, target);
    return null;
  }, [inputs, mode, values.targetApr]);

  const plan: RtbPlan = useMemo(
    () => solved ? solved.plan : buildRtbPlan(inputs, { scheduleStepMonths: stepMonths }),
    [inputs, solved, stepMonths],
  );

  // The target rate starts at whatever the current deal implies, so switching
  // to "solve" mode lands on the same deal rather than a different one.
  const effectiveTarget = useMemo(() => {
    const typed = Number.parseFloat(values.targetApr);
    if (Number.isFinite(typed)) return typed;
    return buildRtbPlan(inputs).impliedAprPct ?? 0;
  }, [values.targetApr, inputs]);

  const setField = (key: keyof RtbFormValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set({ [key]: e.target.value } as Partial<RtbFormValues>);

  return (
    <div className="space-y-4">
      {/* ── The deal ─────────────────────────────────────────────────── */}
      <Card>
        <CardTitle>The deal</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Every figure is editable. The monthly payment includes VAT, and the car&apos;s price is what
          the rentee is buying — the deposit comes off it.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          {variant === 'standalone' && vehicles && vehicles.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-parchment">Vehicle</span>
              <select
                className={inputCls}
                value={ownVehicleId}
                onChange={(e) => setOwnVehicleId(e.target.value)}
              >
                <option value="">Not from the fleet…</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>{v.registration}</option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Car price (£)</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className={`${inputCls} tnum`}
              value={values.vehiclePrice}
              onChange={setField('vehiclePrice')}
              name={variant === 'form' ? 'vehicle_price' : undefined}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Deposit (£)</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className={`${inputCls} tnum`}
              value={values.deposit}
              onChange={setField('deposit')}
              name={variant === 'form' ? 'deposit' : undefined}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Term (months)</span>
            <input
              type="number"
              min={1}
              className={`${inputCls} tnum`}
              value={values.termMonths}
              onChange={setField('termMonths')}
              name={variant === 'form' ? 'term_months' : undefined}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Monthly payment (£, inc VAT)</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className={`${inputCls} tnum`}
              value={values.monthlyPayment}
              onChange={setField('monthlyPayment')}
              name={variant === 'form' ? 'monthly_gross' : undefined}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">VAT rate (%)</span>
            <input
              type="number"
              step="1"
              className={`${inputCls} tnum`}
              value={values.vatRate}
              onChange={setField('vatRate')}
              name={variant === 'form' ? 'vat_rate' : undefined}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Option credit (£ a month)</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className={`${inputCls} tnum`}
              value={values.optionCredit}
              onChange={setField('optionCredit')}
              name={variant === 'form' ? 'option_credit_monthly' : undefined}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Buyout price (£)</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className={`${inputCls} tnum`}
              value={values.agreedResidual}
              onChange={setField('agreedResidual')}
              name={variant === 'form' ? 'agreed_residual' : undefined}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">What the car cost us (£)</span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className={`${inputCls} tnum`}
              value={values.vehicleCost}
              placeholder={values.vehiclePrice || '0.00'}
              onChange={setField('vehicleCost')}
              name={variant === 'form' ? 'vehicle_cost' : undefined}
            />
          </label>
        </div>

        <p className="mt-3 text-xs text-muted">
          The option credit is the part of each monthly payment credited against the buyout, so the
          rentee owns part of the car as they go. The buyout price is what they pay to take it at the
          end of the term.
        </p>
      </Card>

      {/* ── What to calculate ────────────────────────────────────────── */}
      {variant === 'standalone' && (
        <Card>
          <CardTitle>What to calculate</CardTitle>
          <fieldset className="mt-3">
            <legend className="eyebrow text-parchment">Question</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {(
                [
                  ['price', 'Price this deal'],
                  ['payment', 'Solve the monthly payment'],
                  ['buyout', 'Solve the buyout price'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm text-cream">
                  <input
                    type="radio"
                    name="rtb_mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="accent-[var(--color-gold)]"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {mode !== 'price' && (
            <label className="mt-4 flex flex-col gap-1">
              <span className="eyebrow text-parchment">Target rate (% a year)</span>
              <input
                type="number"
                step="0.1"
                inputMode="decimal"
                className={`${inputCls} tnum`}
                value={values.targetApr || effectiveTarget.toFixed(1)}
                onChange={setField('targetApr')}
              />
              <span className="text-xs text-muted">
                {mode === 'payment'
                  ? 'The monthly payment that lands the deal on this rate.'
                  : 'The buyout price that lands the deal on this rate.'}
              </span>
            </label>
          )}
        </Card>
      )}

      {/* ── The answer ───────────────────────────────────────────────── */}
      {solved && (
        <Card className="border-[var(--color-gold)]">
          <CardTitle>
            {mode === 'payment' ? 'The monthly payment' : 'The buyout price'}
          </CardTitle>
          <p className="mt-2 font-display text-3xl tnum text-gold-bright">
            {mode === 'payment'
              ? `${money(solved.valuePence)} a month`
              : solved.valuePence === 0
                ? 'No buyout payment'
                : money(solved.valuePence)}
          </p>
          {solved.warnings.map((w) => (
            <p key={w} className="mt-2 text-sm text-[var(--color-warn)]">{w}</p>
          ))}
        </Card>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Total to own"
          value={money(plan.totalToOwnPence)}
          hint={`${money(plan.costOfCreditPence)} of credit on a ${money(plan.inputs.vehiclePricePence)} car`}
          tone="gold"
        />
        <Stat
          label="Equity at the end"
          value={`${plan.equityFinalPctOfVehicle.toFixed(1)}%`}
          hint={money(plan.equityFinalPence)}
        />
        <Stat
          label="Buyout balance"
          value={money(plan.buyoutBalancePence)}
          hint={plan.buyoutSurplusPence > 0 ? `${money(plan.buyoutSurplusPence)} of equity over` : `buyout at ${money(plan.agreedResidualPence)}`}
        />
        <Stat
          label="Implied rate"
          value={pct(plan.impliedAprPct)}
          hint={plan.impliedAprEffectivePct !== null ? `${plan.impliedAprEffectivePct.toFixed(1)}% effective` : undefined}
          tone={plan.impliedAprPct !== null ? 'profit' : 'warn'}
        />
      </section>

      {plan.impliedAprNote && (
        <p className="text-sm text-[var(--color-warn)]">{plan.impliedAprNote}</p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>What it costs the rentee</CardTitle>
          <Table className="mt-3" caption="What the rent-to-buy costs the rentee">
            <tbody>
              <Row label="Monthly payment (inc. VAT)" value={money(plan.monthlyPaymentPence)} />
              <Row label="Of which VAT" value={money(plan.monthlyVatPence)} muted />
              <Row label="Rent over the term" value={money(plan.totalRentGrossPence)} />
              <Row label="Of which net of VAT" value={money(plan.totalRentNetPence)} muted />
              <Row label="Deposit" value={money(plan.depositPence)} />
              <Row label="Buyout balance at the end" value={money(plan.buyoutBalancePence)} />
              <Row label="Total cost to own" value={money(plan.totalToOwnPence)} strong />
              <Row label="Cost of credit" value={money(plan.costOfCreditPence)} />
              <Row label="Amount financed" value={money(plan.amountFinancedPence)} muted />
              <Row label="Implied rate (nominal)" value={pct(plan.impliedAprPct)} />
              <Row label="Implied rate (effective)" value={pct(plan.impliedAprEffectivePct)} muted />
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardTitle>What Brownhill makes</CardTitle>
          <Table className="mt-3" caption="What the rent-to-buy earns Brownhill">
            <tbody>
              <Row label="What the car cost" value={money(plan.vehicleCostPence)} />
              <Row label="Deposit received" value={money(plan.depositPence)} />
              <Row label="Net rent over the term" value={money(plan.totalRentNetPence)} />
              <Row label="Buyout price" value={money(plan.agreedResidualPence)} />
              <Row label="Margin on the deal" value={money(plan.companyMarginPence)} strong />
              <Row label="Money multiple" value={plan.companyMoneyMultiple !== null ? `${plan.companyMoneyMultiple.toFixed(2)}×` : '—'} />
              <Row label="Yield on the car (nominal)" value={pct(plan.companyYieldPct)} />
              <Row label="Yield (effective)" value={pct(plan.companyYieldEffectivePct)} muted />
            </tbody>
          </Table>
          {plan.companyYieldNote && (
            <p className="mt-3 text-sm text-[var(--color-warn)]">{plan.companyYieldNote}</p>
          )}
        </Card>
      </div>

      <Card>
        <CardTitle>The buyout</CardTitle>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="eyebrow text-parchment">Equity at the end</p>
            <p className="mt-1 font-display text-2xl tnum text-cream">{money(plan.equityFinalPence)}</p>
            <p className="text-xs text-muted">
              {plan.equityFinalPctOfVehicle.toFixed(1)}% of the car — the deposit plus every month&apos;s
              credited rent.
            </p>
          </div>
          <div>
            <p className="eyebrow text-parchment">Buyout price</p>
            <p className="mt-1 font-display text-2xl tnum text-cream">{money(plan.agreedResidualPence)}</p>
            <p className="text-xs text-muted">What the rentee pays to take the car at the end of the term.</p>
          </div>
          <div>
            <p className="eyebrow text-parchment">Still owed</p>
            <p className="mt-1 font-display text-2xl tnum text-cream">{money(plan.buyoutBalancePence)}</p>
            <p className="text-xs text-muted">
              {plan.buyoutSurplusPence > 0
                ? `Their equity is ${money(plan.buyoutSurplusPence)} above the buyout price.`
                : 'Buyout price less the equity built up.'}
            </p>
          </div>
        </div>
      </Card>

      {variant === 'standalone' && (
        <Card>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <CardTitle>Equity schedule</CardTitle>
            <label className="flex items-center gap-2 text-sm text-parchment">
              <span className="eyebrow">Every</span>
              <select
                className={inputCls}
                value={stepMonths}
                onChange={(e) => setStepMonths(Number.parseInt(e.target.value, 10) || 12)}
              >
                <option value={1}>Month</option>
                <option value={3}>3 months</option>
                <option value={6}>6 months</option>
                <option value={12}>Year</option>
              </select>
            </label>
          </div>
          <Table className="mt-3" caption="Equity and buyout balance over the term">
            <thead>
              <tr>
                <Th>Month</Th>
                <Th className="text-right">Rent paid</Th>
                <Th className="text-right">Credited</Th>
                <Th className="text-right">Equity</Th>
                <Th className="text-right">% of car</Th>
                <Th className="text-right">Buyout balance</Th>
              </tr>
            </thead>
            <tbody>
              {plan.schedule.map((row) => (
                <tr key={row.month}>
                  <Td>
                    <span className="tnum">{row.month}</span>
                    {row.month % 12 === 0 && (
                      <span className="ml-2 text-xs text-muted">year {row.month / 12}</span>
                    )}
                  </Td>
                  <Td className="text-right"><Money pence={row.rentPaidPence} showPence={false} /></Td>
                  <Td className="text-right"><Money pence={row.optionCreditPence} showPence={false} /></Td>
                  <Td className="text-right"><Money pence={row.equityPence} showPence={false} /></Td>
                  <Td className="text-right tnum">{row.pctOfVehicle.toFixed(1)}%</Td>
                  <Td className="text-right"><Money pence={row.buyoutBalancePence} showPence={false} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {plan.weeklyRoundingPence !== 0 && (
            <p className="mt-3 text-xs text-muted">
              The agreement bills weekly: {money(plan.weeklyGrossPence)} a week over {plan.termWeeks} weeks
              is {money(plan.weeklyBillingTotalPence)}, {money(Math.abs(plan.weeklyRoundingPence))}{' '}
              {plan.weeklyRoundingPence > 0 ? 'more' : 'less'} than the monthly contract.
            </p>
          )}
        </Card>
      )}

      {variant === 'form' && (
        <input type="hidden" name="rtb_present" value="1" />
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <tr>
      <Th scope="row" className={strong ? 'text-cream' : undefined}>
        {label}
        {strong && <Badge tone="gold" className="ml-2">headline</Badge>}
      </Th>
      <Td className={`text-right ${strong ? 'text-cream' : muted ? 'text-muted' : ''}`}>
        <span className="tnum">{value}</span>
      </Td>
    </tr>
  );
}
