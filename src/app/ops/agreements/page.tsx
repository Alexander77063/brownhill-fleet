import Link from 'next/link';
import { PageHeader, Card, CardTitle, Stat, Badge, Money, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getAgreements, getLookups, getVehicles, getDrivers } from '@/lib/queries';
import { NewAgreementForm } from '@/components/rtb/NewAgreementForm';
import type { RtbVehicleOption } from '@/components/rtb/RtbCalculator';
import { BrandingNotice } from '@/components/BrandingNotice';
import { formatDate, titleCase, agreementStatusTone } from '@/lib/display';

export const dynamic = 'force-dynamic';

export default async function AgreementsPage() {
  const [agreements, lookups, vehicles, drivers] = await Promise.all([
    getAgreements(),
    getLookups(),
    getVehicles(),
    getDrivers(),
  ]);

  // The form needs the car's price and its residual estimate so it can fill
  // the deal figures when a vehicle is picked.
  const vehicleOptions: RtbVehicleOption[] = vehicles.map((v) => ({
    id: v.id,
    registration: v.registration,
    list_value_pence: v.list_value_pence,
    residual_estimate_pence: v.residual_estimate_pence,
  }));
  const driverOptions = drivers.map((d) => ({ id: d.id, full_name: d.full_name }));

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
        <NewAgreementForm vehicles={vehicleOptions} drivers={driverOptions} />
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
