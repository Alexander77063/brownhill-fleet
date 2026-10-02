import Link from 'next/link';
import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { getArrears, getLookups, getAgreements } from '@/lib/queries';
import { getRecentPayments } from '@/lib/queries-ops';
import { recordPayment } from '@/lib/actions/ops';
import { formatDate, titleCase } from '@/lib/display';
import { hasEntitlement } from '@/lib/entitlements';
import { payFirst } from '@/lib/region';
import { SubscriptionSection } from './SubscriptionSection';

export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  // NG-2: in a pay-first market the tenant's own subscription to us comes
  // first; the rental arrears below exist only for tenants that bought rental.
  const pay = payFirst();
  const rental = await hasEntitlement('rental.core');
  const [arrears, lookups, payments, agreements] = await Promise.all([
    getArrears(),
    getLookups(),
    getRecentPayments(20),
    getAgreements(),
  ]);

  const totalBilled = arrears.reduce((s, a) => s + (a.billed_pence ?? 0), 0);
  const totalCollected = arrears.reduce((s, a) => s + (a.collected_pence ?? 0), 0);
  const totalOutstanding = arrears.reduce((s, a) => s + (a.outstanding_pence ?? 0), 0);
  const inArrears = arrears.filter((a) => (a.outstanding_pence ?? 0) > 0);
  const billableAgreements = agreements.filter((a) => a.status === 'active' || a.status === 'defaulted');

  return (
    <>
      <PageHeader
        eyebrow="Billing"
        help="page.billing"
        title="Billing & collections"
        subtitle={
          rental
            ? 'Accrued rent, cash collected and arrears across all agreements. Record manual receipts and they allocate to the oldest open invoices.'
            : 'Your protection subscription: status, renewal date and every invoice from us.'
        }
      />

      {pay && <SubscriptionSection />}

      {rental && (
      <>
      {/* 2-up before `sm` — three across overflowed the page at 320px (WCAG 1.4.10). */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Billed" value={<Money pence={totalBilled} showPence={false} />} className="reveal" />
        <Stat label="Collected" value={<Money pence={totalCollected} showPence={false} />} tone="profit" className="reveal" />
        <Stat label="Outstanding" value={<Money pence={totalOutstanding} showPence={false} />} tone={totalOutstanding > 0 ? 'loss' : 'profit'} className="reveal" />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Arrears table */}
        <div className="lg:col-span-2">
          <h2 className="mb-3 font-display text-xl text-cream">Arrears</h2>
          {inArrears.length === 0 ? (
            <EmptyState title="No arrears" hint="Every agreement is fully collected." />
          ) : (
            <Table caption="Arrears">
              <thead>
                <tr>
                  <Th>Vehicle</Th><Th>Driver</Th>
                  <Th className="text-right">Billed</Th><Th className="text-right">Collected</Th><Th className="text-right">Outstanding</Th><Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {inArrears.map((a) => (
                  <tr key={a.agreement_id}>
                    <Td className="text-cream">{lookups.vehicleById.get(a.vehicle_id)?.registration ?? '—'}</Td>
                    <Td>{lookups.driverById.get(a.driver_id)?.full_name ?? '—'}</Td>
                    <Td className="text-right"><Money pence={a.billed_pence} /></Td>
                    <Td className="text-right"><Money pence={a.collected_pence} /></Td>
                    <Td className="text-right"><Money pence={a.outstanding_pence} className="text-[var(--color-loss)]" /></Td>
                    <Td className="text-right"><Button href={`/ops/agreements/${a.agreement_id}`} variant="ghost" size="sm">View</Button></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {/* Record payment form */}
        <Card>
          <CardTitle>Record payment</CardTitle>
          <form action={recordPayment} className="mt-4 space-y-3">
            <label className="block">
              <span className="eyebrow text-parchment">Agreement</span>
              <select name="agreement_id" required className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2">
                <option value="">Select agreement…</option>
                {billableAgreements.map((a) => (
                  <option key={a.id} value={a.id}>
                    {lookups.vehicleById.get(a.vehicle_id)?.registration ?? '?'} · {lookups.driverById.get(a.driver_id)?.full_name ?? '?'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Amount (£)</span>
              <input name="amount" type="number" step="0.01" min="0.01" required placeholder="825.00"
                className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream tnum focus-visible:outline-2" />
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Source</span>
              <select name="source" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2">
                <option value="bank_transfer">Bank transfer</option>
                <option value="manual">Manual</option>
                <option value="cash">Cash</option>
              </select>
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Received on</span>
              <input name="received_on" type="date"
                className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2" />
            </label>
            <Button type="submit" className="w-full">Record receipt</Button>
          </form>
        </Card>
      </section>

      {/* Recent payments */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Recent payments</h2>
        {payments.length === 0 ? (
          <EmptyState title="No payments recorded" />
        ) : (
          <Table caption="Recent payments">
            <thead>
              <tr><Th>Date</Th><Th>Agreement</Th><Th>Source</Th><Th>Status</Th><Th className="text-right">Amount</Th></tr>
            </thead>
            <tbody>
              {payments.map((p) => {
                const ag = p.agreement_id ? lookups.vehicleById.get(agreements.find((a) => a.id === p.agreement_id)?.vehicle_id ?? '')?.registration : null;
                return (
                  <tr key={p.id}>
                    <Td>{formatDate(p.received_on)}</Td>
                    <Td className="text-cream">{p.agreement_id ? <Link href={`/ops/agreements/${p.agreement_id}`} className="hover:text-gold-bright">{ag ?? 'Agreement'}</Link> : '—'}</Td>
                    <Td>{titleCase(p.source)}</Td>
                    <Td><Badge tone={p.status === 'confirmed' ? 'profit' : p.status === 'failed' ? 'loss' : 'warn'}>{titleCase(p.status)}</Badge></Td>
                    <Td className="text-right"><Money pence={p.amount_pence} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
      </>
      )}
    </>
  );
}
