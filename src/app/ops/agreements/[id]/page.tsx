import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getAgreement, getVehicle, getDriver, getInvoicesForAgreement, getEquityForAgreement } from '@/lib/queries';
import { getCertificatesForDriver } from '@/lib/queries-ops';
import { resolveInsuranceModel } from '@/lib/contracts';
import { formatDate, titleCase, agreementStatusTone, invoiceStatusTone } from '@/lib/display';
import { listSigningSessions, sendForSignature } from '@/lib/actions/signing';
import { completeAgreementAction } from '@/lib/actions/agreements';
import { SigningPanel } from './SigningPanel';

export const dynamic = 'force-dynamic';

function Spec({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-t border-hair-soft py-2.5 first:border-t-0">
      <p className="eyebrow text-parchment">{label}</p>
      <p className="mt-1 text-sm text-cream">{value}</p>
    </div>
  );
}

export default async function AgreementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agreement = await getAgreement(id);
  if (!agreement) notFound();

  const [vehicle, driver, invoices, equity, certs, signingSessions] = await Promise.all([
    getVehicle(agreement.vehicle_id),
    getDriver(agreement.driver_id),
    getInvoicesForAgreement(id),
    agreement.type === 'rtb' ? getEquityForAgreement(id) : Promise.resolve([]),
    getCertificatesForDriver(agreement.driver_id),
    listSigningSessions(id),
  ]);

  // Which contract edition "Generate contract" will produce — derived from the
  // driver's insurance record (self-insured if they hold their own policy).
  const { model } = resolveInsuranceModel(certs);
  const contractEdition =
    agreement.type === 'rtb'
      ? 'Rent-to-Buy'
      : model === 'self'
        ? 'Self-insured'
        : 'Company-insured';

  const billed = invoices.reduce((s, i) => s + i.gross_pence, 0);
  const collected = invoices.reduce((s, i) => s + (i.allocated_pence ?? 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance_pence ?? 0), 0);

  // RTB equity: latest ledger row → equity_total as % of the vehicle list value.
  const latestEquity = equity.length ? equity[equity.length - 1] : null;
  const listValue = vehicle?.list_value_pence ?? 0;
  const equityPct = latestEquity && listValue > 0
    ? Math.min(100, Math.round((latestEquity.equity_total_pence / listValue) * 1000) / 10)
    : 0;

  return (
    <>
      <PageHeader
        eyebrow={`Agreements · ${agreement.type === 'rtb' ? 'Rent-to-Buy' : 'Standard'}`}
        title={vehicle?.registration ?? 'Agreement'}
        subtitle={driver ? `${driver.full_name}` : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button href="/ops/agreements" variant="ghost" size="sm"><Icon name="chevron" className="h-4 w-4 rotate-180" /> Back</Button>
            <Badge tone="gold">{contractEdition}</Badge>
            <Button href={`/api/contracts/${agreement.id}`} target="_blank" variant="primary" size="sm"><Icon name="doc" className="h-4 w-4" /> Open &amp; edit contract</Button>
            <Button href={`/api/contracts/${agreement.id}?download=1`} variant="outline" size="sm"><Icon name="download" className="h-4 w-4" /> Download</Button>
            {/* Manual close-out. The daily cron ends agreements whose term has run, but
                an open-ended rental has no end date for it to act on, and an early
                hand-back needs ending now. Stops weekly rent and notifies the driver. */}
            {agreement.status === 'active' && (
              <form action={completeAgreementAction}>
                <input type="hidden" name="agreement_id" value={agreement.id} />
                <Button type="submit" variant="outline" size="sm">
                  Mark complete
                </Button>
              </form>
            )}
          </div>
        }
      />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Status" value={<Badge tone={agreementStatusTone(agreement.status)}>{titleCase(agreement.status)}</Badge>} className="reveal" />
        <Stat label="Weekly (gross)" value={<Money pence={agreement.weekly_gross_pence} />} className="reveal" />
        <Stat label="Billed" value={<Money pence={billed} showPence={false} />} className="reveal" />
        <Stat label="Outstanding" value={<Money pence={outstanding} showPence={false} />} tone={outstanding > 0 ? 'loss' : 'profit'} className="reveal" />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Terms */}
        <Card>
          <CardTitle>Terms</CardTitle>
          <div className="mt-3">
            <Spec label="Type" value={agreement.type === 'rtb' ? 'Rent-to-Buy' : 'Standard'} />
            <Spec label="Vehicle" value={vehicle?.registration ?? '—'} />
            <Spec label="Driver" value={driver?.full_name ?? '—'} />
            <Spec label="Weekly net" value={<Money pence={agreement.weekly_net_pence} />} />
            <Spec label="Weekly VAT" value={<Money pence={agreement.weekly_vat_pence} />} />
            <Spec label="Weekly gross" value={<Money pence={agreement.weekly_gross_pence} />} />
            <Spec label="Excess mileage" value={<><Money pence={agreement.excess_mile_pence} /> <span className="text-muted">/ mile</span></>} />
          </div>
        </Card>

        {/* Dates & deposit */}
        <Card>
          <CardTitle>Lifecycle</CardTitle>
          <div className="mt-3">
            <Spec label="Start" value={formatDate(agreement.start_date)} />
            <Spec label="End" value={formatDate(agreement.end_date)} />
            <Spec label="Term" value={agreement.term_weeks ? `${agreement.term_weeks} weeks` : 'Rolling'} />
            <Spec label="Deposit" value={<Money pence={agreement.deposit_pence} />} />
            <Spec label="Signed" value={formatDate(agreement.signed_on)} />
            {agreement.type === 'rtb' && (
              <>
                <Spec label="Option credit / wk" value={agreement.option_credit_weekly_pence != null ? <Money pence={agreement.option_credit_weekly_pence} /> : '—'} />
                <Spec label="Agreed residual" value={agreement.agreed_residual_pence != null ? <Money pence={agreement.agreed_residual_pence} /> : '—'} />
              </>
            )}
          </div>
        </Card>

        {/* Equity (RTB only) */}
        <Card>
          <CardTitle>{agreement.type === 'rtb' ? 'Equity progress' : 'Collection'}</CardTitle>
          {agreement.type === 'rtb' ? (
            latestEquity ? (
              <div className="mt-4 space-y-3">
                <div>
                  <p className="eyebrow text-parchment">Accrued equity (wk {latestEquity.week_no})</p>
                  <p className="mt-1 font-display text-3xl tnum text-gold-bright"><Money pence={latestEquity.equity_total_pence} showPence={false} /></p>
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>of {<Money pence={listValue} showPence={false} />} list</span>
                    <span className="tnum text-parchment">{equityPct}%</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-strong)]">
                    <div className="h-full rounded-full bg-gradient-to-r from-gold to-gold-bright" style={{ width: `${equityPct}%` }} />
                  </div>
                </div>
                <p className="text-xs text-muted">Deposit {<Money pence={latestEquity.deposit_pence} showPence={false} />} + credit {<Money pence={latestEquity.cumulative_credit_pence} showPence={false} />}</p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No equity accrued yet.</p>
            )
          ) : (
            <div className="mt-4 space-y-3">
              <div>
                <p className="eyebrow text-parchment">Collected</p>
                <p className="mt-1 font-display text-3xl tnum text-[var(--color-profit)]"><Money pence={collected} showPence={false} /></p>
              </div>
              <div className="border-t border-hair-soft pt-3">
                <p className="eyebrow text-parchment">Outstanding</p>
                <p className="mt-1 font-display text-2xl tnum text-[var(--color-loss)]"><Money pence={outstanding} showPence={false} /></p>
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* Signing */}
      <section className="mt-4">
        <SigningPanel agreementId={agreement.id} sessions={signingSessions} onSend={sendForSignature} />
      </section>

      {/* Invoices */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Invoices</h2>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices issued" />
        ) : (
          <Table caption="Invoices for this agreement">
            <thead>
              <tr>
                <Th>Number</Th><Th>Issued</Th><Th>Due</Th>
                <Th className="text-right">Gross</Th><Th className="text-right">Paid</Th><Th className="text-right">Balance</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <Td className="text-cream">{i.number ?? '—'}</Td>
                  <Td>{formatDate(i.issued_on)}</Td>
                  <Td>{formatDate(i.due_on)}</Td>
                  <Td className="text-right"><Money pence={i.gross_pence} /></Td>
                  <Td className="text-right"><Money pence={i.allocated_pence ?? 0} /></Td>
                  <Td className="text-right"><Money pence={i.balance_pence ?? 0} /></Td>
                  <Td><Badge tone={i.is_overdue ? 'loss' : invoiceStatusTone(i.status)}>{i.is_overdue ? 'Overdue' : titleCase(i.status)}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
