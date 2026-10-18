import Link from 'next/link';
import { PageHeader, Card, CardTitle, Money, Table, Th, Td, EmptyState, Button, Badge } from '@/components/ui';
import { getArrears, getLookups, getAgreements } from '@/lib/queries';
import { getRecentPayments } from '@/lib/queries-ops';
import { recordPayment } from '@/lib/actions/ops';
import { formatDate, titleCase } from '@/lib/display';
import { requireTenantContext, contextCan } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

/**
 * /accounts/billing — read-only arrears view + record-payment form for the
 * accountant. The form is gated on payments.record (per the per-member
 * permission grant); absent that grant the page stays read-only.
 */
export default async function AccountsBillingPage() {
  const ctx = await requireTenantContext();
  const canRead = contextCan(ctx, 'billing.read');
  const canWrite = contextCan(ctx, 'payments.record');
  if (!canRead) {
    return (
      <>
        <PageHeader eyebrow="Accounts" title="Billing" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have permission to read billing. Ask the ops admin to grant
            you <code>billing.read</code>.
          </p>
        </Card>
      </>
    );
  }

  const [arrears, lookups, payments, agreements] = await Promise.all([
    getArrears(),
    getLookups(),
    canWrite ? getRecentPayments(20) : Promise.resolve([] as Awaited<ReturnType<typeof getRecentPayments>>),
    canWrite ? getAgreements() : Promise.resolve([] as Awaited<ReturnType<typeof getAgreements>>),
  ]);

  const total = arrears.reduce((s, a) => s + (a.outstanding_pence ?? 0), 0);
  const billableAgreements = agreements.filter(
    (a) => a.status === 'active' || a.status === 'defaulted',
  );

  return (
    <>
      <PageHeader
        eyebrow="Accounts · Billing"
        title="Arrears & payments"
        subtitle="Outstanding balances, and a record-payment form if you've been granted payments.record."
      />
      <Card>
        <CardTitle>Outstanding total</CardTitle>
        <p className="mt-2 font-display text-3xl tnum text-[var(--color-loss)]">
          <Money pence={total} />
        </p>
      </Card>
      <section className="mt-4">
        {arrears.length === 0 ? (
          <EmptyState title="No arrears" hint="Every agreement is paid up." />
        ) : (
          <Table caption="Arrears">
            <thead>
              <tr>
                <Th>Agreement</Th>
                <Th>Driver</Th>
                <Th>Vehicle</Th>
                <Th className="text-right">Billed</Th>
                <Th className="text-right">Collected</Th>
                <Th className="text-right">Outstanding</Th>
              </tr>
            </thead>
            <tbody>
              {arrears.map((a) => (
                <tr key={a.agreement_id}>
                  <Td className="font-mono text-xs text-muted">{a.agreement_id.slice(0, 8)}…</Td>
                  <Td className="text-xs">{lookups.driverById.get(a.driver_id)?.full_name ?? '—'}</Td>
                  <Td className="text-xs">{lookups.vehicleById.get(a.vehicle_id)?.registration ?? '—'}</Td>
                  <Td className="text-right font-mono"><Money pence={a.billed_pence ?? 0} /></Td>
                  <Td className="text-right font-mono"><Money pence={a.collected_pence ?? 0} /></Td>
                  <Td className="text-right font-mono text-[var(--color-loss)]"><Money pence={a.outstanding_pence ?? 0} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {canWrite && (
        <section className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle>Record payment</CardTitle>
            {billableAgreements.length === 0 ? (
              <EmptyState title="No active agreements" hint="Add an agreement under /ops/agreements first." />
            ) : (
              <form action={recordPayment} className="mt-4 space-y-3">
                <label className="block">
                  <span className="eyebrow text-parchment">Agreement</span>
                  <select
                    name="agreement_id"
                    required
                    className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                  >
                    <option value="">Select agreement…</option>
                    {billableAgreements.map((a) => (
                      <option key={a.id} value={a.id}>
                        {lookups.vehicleById.get(a.vehicle_id)?.registration ?? '?'} ·{' '}
                        {lookups.driverById.get(a.driver_id)?.full_name ?? '?'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="eyebrow text-parchment">Amount (£)</span>
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="825.00"
                    className="mt-1 w-full tnum rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                  />
                </label>
                <label className="block">
                  <span className="eyebrow text-parchment">Source</span>
                  <select name="source" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream">
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="manual">Manual</option>
                    <option value="cash">Cash</option>
                  </select>
                </label>
                <label className="block">
                  <span className="eyebrow text-parchment">Received on</span>
                  <input
                    name="received_on"
                    type="date"
                    className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                  />
                </label>
                <Button type="submit" className="w-full">Record receipt</Button>
              </form>
            )}
          </Card>

          <Card>
            <CardTitle>Recent payments</CardTitle>
            {payments.length === 0 ? (
              <EmptyState title="No payments recorded yet" />
            ) : (
              <Table caption="Recent payments">
                <thead>
                  <tr><Th>Date</Th><Th>Agreement</Th><Th>Source</Th><Th>Status</Th><Th className="text-right">Amount</Th></tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <Td>{formatDate(p.received_on)}</Td>
                      <Td className="text-xs">{p.agreement_id ? <Link href={`/ops/agreements/${p.agreement_id}`} className="hover:text-gold-bright">{p.agreement_id.slice(0, 8)}…</Link> : '—'}</Td>
                      <Td>{titleCase(p.source)}</Td>
                      <Td><Badge tone={p.status === 'confirmed' ? 'profit' : p.status === 'failed' ? 'loss' : 'warn'}>{titleCase(p.status)}</Badge></Td>
                      <Td className="text-right font-mono"><Money pence={p.amount_pence} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </section>
      )}
    </>
  );
}