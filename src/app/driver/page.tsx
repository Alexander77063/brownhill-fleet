import { PageHeader, Card, CardTitle, Badge, Money, Button, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getSessionProfile } from '@/lib/auth';
import { getMyActiveAgreement, getInvoicesForAgreement, getEquityForAgreement } from '@/lib/queries';
import { formatDate } from '@/lib/display';
import { operatorName } from '@/lib/branding';
import { PlanNotice } from '@/components/PlanNotice';

export const dynamic = 'force-dynamic';

export default async function DriverHome({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const p = await getSessionProfile();
  // A driver hires from the operator, not from whoever wrote the software.
  const operator = await operatorName();

  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Your account" title="Welcome" />
        <PlanNotice notice={notice} />
        <EmptyState
          title="No active agreement linked to your account"
          hint={`Once ${operator} sets up your hire, your vehicle, rent and equity will appear here.`}
        />
      </>
    );
  }

  const ag = await getMyActiveAgreement(p.driverId);
  if (!ag) {
    return (
      <>
        <PageHeader eyebrow="Your account" title={`Hello${p.fullName ? `, ${p.fullName.split(' ')[0]}` : ''}`} />
        <PlanNotice notice={notice} />
        <EmptyState
          title="No active agreement linked to your account"
          hint={`Once ${operator} sets up your hire, your vehicle, rent and equity will appear here.`}
        />
      </>
    );
  }

  const invoices = await getInvoicesForAgreement(ag.id);
  const outstanding = invoices
    .filter((i) => i.status !== 'paid' && i.status !== 'void')
    .reduce((s, i) => s + (i.balance_pence ?? 0), 0);

  // Next payment = earliest still-owing invoice.
  const owing = invoices
    .filter((i) => i.status !== 'paid' && i.status !== 'void' && (i.balance_pence ?? 0) > 0)
    .sort((a, b) => a.due_on.localeCompare(b.due_on));
  const next = owing[0];
  const overdueCount = invoices.filter((i) => i.is_overdue).length;
  const settled = outstanding <= 0;

  const isRtb = ag.type === 'rtb';
  let equityTotal = ag.deposit_pence;
  let equityPct: number | null = null;
  if (isRtb) {
    const ledger = await getEquityForAgreement(ag.id);
    const last = ledger[ledger.length - 1];
    if (last) equityTotal = last.equity_total_pence;
    const listVal = ag.vehicle?.list_value_pence ?? 0;
    if (listVal > 0) equityPct = Math.round((equityTotal / listVal) * 1000) / 10;
  }

  return (
    <>
      <PageHeader
        eyebrow="Your account"
        title={`Hello${p.fullName ? `, ${p.fullName.split(' ')[0]}` : ''}`}
        subtitle={ag.vehicle ? `${ag.vehicle.make} ${ag.vehicle.model} · ${ag.vehicle.registration}` : undefined}
      />
      <PlanNotice notice={notice} />

      {/* Hero: balance + this week's position */}
      <Card className="reveal bg-gradient-to-b from-[rgba(184,151,42,0.07)] to-transparent">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow text-parchment">Account balance</p>
            <p className={`mt-2 font-display text-5xl tnum ${settled ? 'text-[var(--color-profit)]' : 'text-cream'}`}>
              <Money pence={outstanding} />
            </p>
            <div className="mt-3">
              {settled ? (
                <Badge tone="profit"><Icon name="check" className="h-3.5 w-3.5" /> All paid up</Badge>
              ) : overdueCount > 0 ? (
                <Badge tone="loss"><Icon name="alert" className="h-3.5 w-3.5" /> {overdueCount} overdue</Badge>
              ) : (
                <Badge tone="warn"><Icon name="clock" className="h-3.5 w-3.5" /> Payment due</Badge>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="eyebrow text-parchment">Next payment</p>
            {next ? (
              <>
                <p className="mt-2 font-display text-2xl tnum text-cream"><Money pence={next.balance_pence ?? 0} /></p>
                <p className="mt-1 text-xs text-muted">due {formatDate(next.due_on)}</p>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted">Nothing due</p>
            )}
            <Button href="/driver/payments" size="sm" className="mt-3">Pay now</Button>
          </div>
        </div>
      </Card>

      {/* Hire terms */}
      <section className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card className="reveal">
          <p className="eyebrow text-parchment">Vehicle</p>
          <p className="mt-2 text-lg text-cream">{ag.vehicle?.registration ?? '—'}</p>
          <p className="text-xs text-muted">{ag.vehicle ? `${ag.vehicle.make} ${ag.vehicle.model}` : ''}</p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Weekly rent</p>
          <p className="mt-2 font-display text-2xl tnum text-gold-bright"><Money pence={ag.weekly_gross_pence} /></p>
          <p className="text-xs text-muted">incl. VAT</p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Deposit held</p>
          <p className="mt-2 font-display text-2xl tnum text-cream"><Money pence={ag.deposit_pence} /></p>
          <p className="text-xs text-muted">{isRtb ? 'counts toward equity' : 'refundable'}</p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Agreement</p>
          <p className="mt-2 text-lg text-cream">{isRtb ? 'Rent-to-Buy' : 'Standard'}</p>
          <p className="text-xs text-muted">{ag.term_weeks ? `${ag.term_weeks} weeks` : 'rolling'}</p>
        </Card>
      </section>

      {/* RTB equity teaser */}
      {isRtb && (
        <Card as="section" className="reveal mt-4 bg-gradient-to-r from-[rgba(184,151,42,0.10)] to-transparent">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <CardTitle>You&rsquo;re buying this car</CardTitle>
              <p className="mt-2 text-sm text-parchment">
                <span className="font-display text-2xl text-gold-bright tnum"><Money pence={equityTotal} /></span> built
                {equityPct !== null && <> — <span className="text-cream">{equityPct}%</span> of your car</>}
              </p>
            </div>
            <Button href="/driver/equity" variant="outline" size="sm">
              <Icon name="trending" className="h-4 w-4" /> View equity journey
            </Button>
          </div>
        </Card>
      )}

      {/* Quick links */}
      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { href: '/driver/insurance', label: 'Insurance', icon: 'shield' as const },
          { href: '/driver/charges', label: 'Charges', icon: 'alert' as const },
          { href: '/driver/payments', label: 'Payments', icon: 'receipt' as const },
          { href: '/driver/documents', label: 'Documents', icon: 'doc' as const },
        ].map((q) => (
          <Button key={q.href} href={q.href} variant="ghost" className="reveal justify-start border border-hair-soft">
            <Icon name={q.icon} className="h-4 w-4 text-gold" /> {q.label}
          </Button>
        ))}
      </section>
    </>
  );
}
