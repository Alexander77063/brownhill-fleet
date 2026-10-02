import Link from 'next/link';
import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getAgreements, getLookups, getVehicles, getDrivers } from '@/lib/queries';
import { createAgreement } from '@/lib/actions/ops';
import { BrandingNotice } from '@/components/BrandingNotice';
import { formatDate, titleCase, agreementStatusTone } from '@/lib/display';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export default async function AgreementsPage() {
  const [agreements, lookups, vehicles, drivers] = await Promise.all([
    getAgreements(),
    getLookups(),
    getVehicles(),
    getDrivers(),
  ]);

  const active = agreements.filter((a) => a.status === 'active').length;
  const rtb = agreements.filter((a) => a.type === 'rtb').length;
  const weeklyNet = agreements
    .filter((a) => a.status === 'active')
    .reduce((s, a) => s + a.weekly_net_pence, 0);

  return (
    <>
      <PageHeader
        eyebrow="Agreements"
        help="page.agreements"
        title="Hire agreements"
        subtitle="Standard rentals and rent-to-buy instances across the fleet, with weekly terms and lifecycle status."
      />

      <BrandingNotice />

      {/* 2-up before `sm` — three across overflowed the page at 320px (WCAG 1.4.10). */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Active" value={active} tone="profit" className="reveal" />
        <Stat label="Rent-to-Buy" value={rtb} tone="gold" className="reveal" />
        <Stat label="Weekly net (active)" value={<Money pence={weeklyNet} showPence={false} />} className="reveal" />
      </section>

      <Card className="mt-5">
        <CardTitle>New agreement</CardTitle>
        <form action={createAgreement} className="mt-4 flex flex-wrap gap-3">
          {/* These wrappers are <label> rather than <div>: the caption text was already
              visible, but only a real label associates it with the control for assistive
              tech (WCAG 1.3.1 / 4.1.2). Layout is unchanged. */}
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Type</span>
            <select name="type" className={inputCls} defaultValue="standard">
              <option value="standard">Standard rental</option>
              <option value="rtb">Rent-to-buy</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Vehicle</span>
            <select name="vehicle_id" required className={inputCls} defaultValue="">
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
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Status</span>
            <select name="status" className={inputCls} defaultValue="active">
              <option value="active">Active</option>
              <option value="draft">Draft</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Term weeks (rent-to-buy)</span>
            <input type="number" name="term_weeks" placeholder="156" className={`${inputCls} tnum`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow text-parchment">Weekly option credit (£, rent-to-buy)</span>
            <input type="number" step="0.01" name="option_credit_weekly" placeholder="0.00" className={`${inputCls} tnum`} />
          </label>
          <div className="flex w-full flex-col gap-2 pt-1">
            <p className="text-sm text-muted">Rent-to-buy needs a term and weekly option credit. Set to Active to start weekly billing.</p>
            <div>
              <Button type="submit" variant="primary">Create agreement</Button>
            </div>
          </div>
        </form>
      </Card>

      <section className="mt-5">
        {agreements.length === 0 ? (
          <EmptyState title="No agreements yet" hint="Create an agreement to begin billing." />
        ) : (
          <Table caption="Agreements">
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Vehicle</Th>
                <Th>Driver</Th>
                <Th>Status</Th>
                <Th className="text-right">Weekly (net)</Th>
                <Th>Start</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((a) => (
                <tr key={a.id} className="group transition-colors hover:bg-[var(--surface-soft)]">
                  <Td className="text-cream">
                    <Link href={`/ops/agreements/${a.id}`} className="inline-flex items-center gap-2 hover:text-gold-bright">
                      {a.type === 'rtb' ? 'Rent-to-Buy' : 'Standard'}
                    </Link>
                  </Td>
                  <Td>{lookups.vehicleById.get(a.vehicle_id)?.registration ?? '—'}</Td>
                  <Td>{lookups.driverById.get(a.driver_id)?.full_name ?? '—'}</Td>
                  <Td><Badge tone={agreementStatusTone(a.status)}>{titleCase(a.status)}</Badge></Td>
                  <Td className="text-right"><Money pence={a.weekly_net_pence} /></Td>
                  <Td>{formatDate(a.start_date)}</Td>
                  <Td className="text-right">
                    {/* Decorative — the first cell already links here with a real name. */}
                    <Link
                      href={`/ops/agreements/${a.id}`}
                      aria-hidden="true"
                      tabIndex={-1}
                      className="text-gold-bright opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <Icon name="chevron" className="h-4 w-4" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
