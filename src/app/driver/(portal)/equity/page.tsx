import { PageHeader, Card, CardTitle, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getSessionProfile } from '@/lib/auth';
import { getMyActiveAgreement, getEquityForAgreement } from '@/lib/queries';
import { rtbEquityAtWeek } from '@/lib/finance';
import { formatDate, daysUntil } from '@/lib/display';
import { operatorName } from '@/lib/branding';

export const dynamic = 'force-dynamic';

const MILESTONES = [13, 26, 52, 104, 156];

export default async function DriverEquity() {
  const p = await getSessionProfile();
  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Rent-to-Buy" title="My equity" />
        <EmptyState title="No active agreement linked to your account" />
      </>
    );
  }

  const ag = await getMyActiveAgreement(p.driverId);

  if (!ag || ag.type !== 'rtb') {
    return (
      <>
        <PageHeader eyebrow="Rent-to-Buy" title="My equity" />
        <EmptyState
          title="Equity applies to Rent-to-Buy hires only"
          hint={`You're on a standard rental, so your payments are rent rather than instalments toward ownership. Ask ${await operatorName()} about switching to Rent-to-Buy.`}
        />
      </>
    );
  }

  const listValue = ag.vehicle?.list_value_pence ?? 0;
  const optionCredit = ag.option_credit_weekly_pence ?? 0;
  const deposit = ag.deposit_pence;
  const residual = ag.agreed_residual_pence ?? 0;
  const termWeeks = ag.term_weeks ?? 156;

  // Current position: prefer the seeded ledger; otherwise project from start_date.
  const ledger = await getEquityForAgreement(ag.id);
  const last = ledger[ledger.length - 1];
  let currentWeek = last?.week_no ?? 0;
  if (!last && ag.start_date) {
    const elapsed = -1 * (daysUntil(ag.start_date) ?? 0);
    currentWeek = Math.max(0, Math.min(termWeeks, Math.floor(elapsed / 7)));
  }
  const current = last
    ? { equityTotalPence: last.equity_total_pence, cumulativeCreditPence: last.cumulative_credit_pence }
    : rtbEquityAtWeek(currentWeek, optionCredit, deposit, listValue);

  const equityTotal = current.equityTotalPence;
  const pctOfVehicle = listValue > 0 ? Math.round((equityTotal / listValue) * 1000) / 10 : 0;
  const pctToResidual = residual > 0 ? Math.min(100, Math.round((equityTotal / residual) * 1000) / 10) : 0;
  const remainingToBuyout = Math.max(0, residual - equityTotal);

  return (
    <>
      <PageHeader
        eyebrow="Rent-to-Buy"
        title="My equity"
        subtitle={ag.vehicle ? `${ag.vehicle.make} ${ag.vehicle.model} · ${ag.vehicle.registration}` : undefined}
      />

      {/* Hero */}
      <Card className="reveal bg-gradient-to-b from-[rgba(184,151,42,0.08)] to-transparent">
        <p className="eyebrow text-parchment">Equity built so far</p>
        <p className="mt-2 font-display text-5xl tnum text-gold-bright"><Money pence={equityTotal} /></p>
        <p className="mt-2 text-sm text-parchment">
          That&rsquo;s <span className="text-cream">{pctOfVehicle}%</span> of your {ag.vehicle?.model ?? 'vehicle'} ·
          week <span className="text-cream tnum">{currentWeek}</span> of {termWeeks}
        </p>

        {/* Progress to buyout */}
        <div className="mt-5">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted">Progress to buyout</span>
            <span className="tnum text-parchment">{pctToResidual}%</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full border border-hair-soft bg-[rgba(0,0,0,0.3)]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-gold-dim to-gold-bright"
              style={{ width: `${pctToResidual}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted">
            <span><Money pence={equityTotal} /> built</span>
            <span><Money pence={residual} /> buyout target</span>
          </div>
        </div>
      </Card>

      {/* Breakdown */}
      <section className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card className="reveal">
          <p className="eyebrow text-parchment">Deposit credit</p>
          <p className="mt-2 font-display text-2xl tnum text-cream"><Money pence={deposit} /></p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Weekly option credit</p>
          <p className="mt-2 font-display text-2xl tnum text-cream"><Money pence={optionCredit} /></p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Credits accrued</p>
          <p className="mt-2 font-display text-2xl tnum text-cream"><Money pence={current.cumulativeCreditPence} /></p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Left to buyout</p>
          <p className="mt-2 font-display text-2xl tnum text-gold-bright"><Money pence={remainingToBuyout} /></p>
        </Card>
      </section>

      {/* Milestone timeline */}
      <section className="mt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-xl text-cream">Your ownership journey</h2>
          <Button href="/driver/payments" variant="ghost" size="sm">Payments <Icon name="chevron" className="h-4 w-4" /></Button>
        </div>
        <Table caption="Your ownership journey">
          <thead>
            <tr>
              <Th>Milestone</Th><Th>Credits accrued</Th><Th>Equity total</Th>
              <Th>% of vehicle</Th><Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {MILESTONES.filter((w) => w <= termWeeks || w === MILESTONES[0]).map((week) => {
              const proj = rtbEquityAtWeek(Math.min(week, termWeeks), optionCredit, deposit, listValue);
              const reached = currentWeek >= week;
              return (
                <tr key={week}>
                  <Td className="text-cream">Week {week}</Td>
                  <Td><Money pence={proj.cumulativeCreditPence} /></Td>
                  <Td className="text-cream"><Money pence={proj.equityTotalPence} /></Td>
                  <Td className="tnum">{proj.pctOfVehicle}%</Td>
                  <Td>
                    {reached
                      ? <Badge tone="profit"><Icon name="check" className="h-3.5 w-3.5" /> Reached</Badge>
                      : <Badge tone="neutral">Upcoming</Badge>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <p className="mt-3 text-xs text-muted">
          Equity is your refundable deposit plus the option credit accrued each week. At week {termWeeks} you can settle
          the agreed buyout of <Money pence={residual} /> to own the vehicle outright
          {ag.start_date && <> (target {formatDate(ag.end_date)})</>}.
        </p>
      </section>
    </>
  );
}
