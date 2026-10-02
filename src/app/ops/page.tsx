import { PageHeader, Stat, Card, CardTitle, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getFleetEconomics, getObligations, getArrears } from '@/lib/queries';
import { getTenantChecklist } from '@/lib/onboarding-checklist';
import { OnboardingChecklist } from '@/components/OnboardingChecklist';
import { BrandingNotice } from '@/components/BrandingNotice';
import { PlanNotice } from '@/components/PlanNotice';
import { AssistantPanel } from '@/components/ops/AssistantPanel';
import { formatDate, daysUntil, severityTone, titleCase, vehicleStatusTone } from '@/lib/display';

export const dynamic = 'force-dynamic';

export default async function OpsDashboard({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const [econ, obligations, arrears, checklist] = await Promise.all([
    getFleetEconomics(),
    getObligations(),
    getArrears(),
    getTenantChecklist(),
  ]);

  const fleetCount = econ.length;
  const onHire = econ.filter((e) => e.status === 'on_hire').length;
  const avgOccupancy =
    econ.length ? Math.round((econ.reduce((s, e) => s + (e.occupancy_12m_pct ?? 0), 0) / econ.length) * 10) / 10 : 0;
  const contractedProfit = econ.reduce((s, e) => s + (e.contracted_annual_profit_pence ?? 0), 0);
  const weeklyRecurring = econ.reduce((s, e) => s + Math.round((e.contracted_annual_net_pence ?? 0) / 52), 0);
  const outstanding = arrears.reduce((s, a) => s + (a.outstanding_pence ?? 0), 0);
  const critical = obligations.filter((o) => o.severity === 'critical' || o.status === 'overdue');

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Command centre"
        subtitle="Live position across the fleet — occupancy, contracted profit, arrears and compliance at a glance."
        actions={<Button href="/ops/agreements" size="sm" variant="outline"><Icon name="plus" className="h-4 w-4" /> New agreement</Button>}
      />

      <PlanNotice notice={notice} />
      <BrandingNotice />

      <div className="mb-4">
        <OnboardingChecklist title="Finish setting up your fleet" items={checklist} />
      </div>

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Fleet" value={fleetCount} hint={`${onHire} on hire`} className="reveal" />
        <Stat label="Avg occupancy (12m)" value={`${avgOccupancy}%`} tone={avgOccupancy >= 90 ? 'profit' : 'warn'} className="reveal" />
        <Stat label="Weekly recurring (net)" value={<Money pence={weeklyRecurring} showPence={false} />} tone="gold" className="reveal" />
        <Stat label="Contracted annual profit" value={<Money pence={contractedProfit} showPence={false} />} tone="profit" className="reveal" />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Compliance alerts */}
        <Card className="lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <CardTitle>Compliance & risk</CardTitle>
            <Button href="/ops/compliance" variant="ghost" size="sm">View all <Icon name="chevron" className="h-4 w-4" /></Button>
          </div>
          {obligations.length === 0 ? (
            <EmptyState title="Nothing outstanding" hint="All licences, insurance and finance milestones are clear." />
          ) : (
            <ul className="space-y-2">
              {obligations.slice(0, 6).map((o) => {
                const d = daysUntil(o.due_date);
                return (
                  <li key={o.id} className="flex items-center gap-3 rounded-[var(--radius)] border border-hair-soft px-3 py-2.5">
                    <span className={`text-[var(--color-${severityTone(o.severity) === 'loss' ? 'loss' : severityTone(o.severity) === 'warn' ? 'warn' : 'info'})]`}>
                      <Icon name={o.status === 'overdue' ? 'alert' : 'clock'} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-cream">{o.title}</p>
                      <p className="text-xs text-muted">{titleCase(o.type)} · due {formatDate(o.due_date)}</p>
                    </div>
                    <Badge tone={severityTone(o.severity)}>
                      {d !== null && d < 0 ? `${Math.abs(d)}d overdue` : d !== null ? `${d}d` : o.status}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Money snapshot */}
        <Card>
          <CardTitle>Money</CardTitle>
          <div className="mt-4 space-y-4">
            <div>
              <p className="eyebrow text-parchment">Outstanding (arrears)</p>
              <p className="mt-1 font-display text-3xl tnum text-[var(--color-loss)]"><Money pence={outstanding} /></p>
            </div>
            <div className="border-t border-hair-soft pt-4">
              <p className="eyebrow text-parchment">Open critical items</p>
              <p className="mt-1 font-display text-3xl tnum text-cream">{critical.length}</p>
            </div>
            <Button href="/ops/billing" variant="outline" size="sm" className="w-full">Go to billing</Button>
          </div>
        </Card>
      </section>

      {/* Fleet Assistant — ready to use, grounded in this tenant's own data */}
      <section className="mt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-xl text-cream">Fleet Assistant</h2>
          <Button href="/ops/assistant" variant="ghost" size="sm">Open <Icon name="chevron" className="h-4 w-4" /></Button>
        </div>
        <AssistantPanel />
      </section>

      {/* Fleet snapshot */}
      <section className="mt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-xl text-cream">Fleet snapshot</h2>
          <Button href="/ops/fleet" variant="ghost" size="sm">All vehicles <Icon name="chevron" className="h-4 w-4" /></Button>
        </div>
        {econ.length === 0 ? (
          <EmptyState title="No vehicles yet" hint="Add your first vehicle to begin." />
        ) : (
          <Table caption="Fleet overview">
            <thead>
              <tr>
                <Th>Vehicle</Th><Th>Status</Th><Th>Hire type</Th>
                <Th>Occupancy</Th><Th>Annual profit</Th><Th>GFV</Th>
              </tr>
            </thead>
            <tbody>
              {econ.map((e) => (
                <tr key={e.vehicle_id}>
                  <Td className="text-cream">{e.registration}</Td>
                  <Td><Badge tone={vehicleStatusTone(e.status)}>{titleCase(e.status)}</Badge></Td>
                  <Td>{e.agreement_type ? (e.agreement_type === 'rtb' ? 'Rent-to-Buy' : 'Standard') : '—'}</Td>
                  <Td className="tnum">{e.occupancy_12m_pct ?? 0}%</Td>
                  <Td><Money pence={e.contracted_annual_profit_pence ?? 0} showPence={false} /></Td>
                  <Td><Badge tone={e.gfv_status === 'confirmed' ? 'profit' : e.gfv_status === 'unconfirmed' ? 'warn' : 'neutral'}>{titleCase(e.gfv_status)}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
