import Link from 'next/link';
import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getFleetEconomics } from '@/lib/queries';
import { VehicleEntry } from '@/components/ops/VehicleEntry';
import { titleCase, vehicleStatusTone, gfvTone } from '@/lib/display';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function FleetPage() {
  const econ = await getFleetEconomics();
  // Who owns each vehicle (insurer policyholders, customers). RLS-scoped.
  const sb = await createClient();
  const { data: owned } = await sb
    .from('vehicles')
    .select('id, owner_id, vehicle_owners(name)')
    .not('owner_id', 'is', null);
  const ownerOf = new Map(
    (owned ?? []).map((v) => [v.id, (v.vehicle_owners as unknown as { name: string } | null)?.name ?? null]),
  );

  const fleetCount = econ.length;
  const onHire = econ.filter((e) => e.status === 'on_hire').length;
  const avgOccupancy =
    econ.length ? Math.round((econ.reduce((s, e) => s + (e.occupancy_12m_pct ?? 0), 0) / econ.length) * 10) / 10 : 0;

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        help="page.fleet"
        title="Vehicles"
        subtitle="Every vehicle, its current hire, occupancy and contracted economics. Select a vehicle for full finance and history."
      />

      {/* 2-up before `sm`: three stat cards side by side overflowed the page at 320px
          (WCAG 1.4.10 Reflow). Same pattern as the 4-stat pages elsewhere. */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Fleet size" value={fleetCount} className="reveal" />
        <Stat label="On hire" value={onHire} tone="profit" className="reveal" />
        <Stat label="Avg occupancy (12m)" value={`${avgOccupancy}%`} tone={avgOccupancy >= 90 ? 'profit' : 'warn'} className="reveal" />
      </section>

      <div className="mt-5">
        <VehicleEntry />
      </div>

      <section className="mt-5">
        {econ.length === 0 ? (
          <EmptyState title="No vehicles yet" hint="Add your first vehicle to begin." />
        ) : (
          <Table caption="Fleet vehicles">
            <thead>
              <tr>
                <Th>Registration</Th>
                <Th>Owner</Th>
                <Th>Status</Th>
                <Th>Hire type</Th>
                <Th className="text-right">Occupancy</Th>
                <Th className="text-right">Annual profit</Th>
                <Th>GFV</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {econ.map((e) => (
                <tr key={e.vehicle_id} className="group transition-colors hover:bg-[var(--surface-soft)]">
                  <Td className="font-display text-cream">
                    <Link href={`/ops/fleet/${e.vehicle_id}`} className="hover:text-gold-bright">
                      {e.registration}
                    </Link>
                  </Td>
                  <Td>{ownerOf.get(e.vehicle_id) ?? <span className="text-muted">—</span>}</Td>
                  <Td><Badge tone={vehicleStatusTone(e.status)}>{titleCase(e.status)}</Badge></Td>
                  <Td>{e.agreement_type ? (e.agreement_type === 'rtb' ? 'Rent-to-Buy' : 'Standard') : '—'}</Td>
                  <Td className="text-right tnum">{e.occupancy_12m_pct ?? 0}%</Td>
                  <Td className="text-right"><Money pence={e.contracted_annual_profit_pence ?? 0} showPence={false} signed /></Td>
                  <Td><Badge tone={gfvTone(e.gfv_status)}>{titleCase(e.gfv_status)}</Badge></Td>
                  <Td className="text-right">
                    {/* Decorative affordance only. The registration cell already links to
                        this exact page with a proper name, so exposing this icon-only
                        duplicate produced a nameless link (axe `link-name`, serious) and a
                        second tab stop that was invisible when focused (opacity-0). Mouse
                        users keep the click; AT and keyboard get the named link instead. */}
                    <Link
                      href={`/ops/fleet/${e.vehicle_id}`}
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
