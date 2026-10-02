import Link from 'next/link';
import { PageHeader, Card, CardTitle, Button, Badge, Table, Th, Td, EmptyState } from '@/components/ui';
import { PlanPicker } from '@/components/collection/PlanPicker';
import { SubscriptionCard } from '@/components/collection/SubscriptionCard';
import { ownerBilling, ownerPlanOffers } from '@/lib/collection/owner-billing';
import { todayISO, UNPAID_STATUSES } from '@/lib/collection/invoices';
import { deploymentProfile } from '@/lib/deployment/profile';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-3 py-2 text-sm text-cream focus:border-gold-bright focus:outline-none';

/**
 * Pay-first: choose a plan and pay; then invoices, receipts and the renewal
 * date. Nothing in the portal works until the first invoice is paid.
 */
export default async function OwnerBillingPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string; pay?: string }> }) {
  const [{ notice, error, pay }, b] = await Promise.all([searchParams, ownerBilling()]);
  const offers = await ownerPlanOffers(b.vehicles);
  const region = deploymentProfile().region;
  const today = todayISO();
  const unpaid = b.invoices.filter((i) => UNPAID_STATUSES.includes(i.status));
  const focus = pay ? unpaid.find((i) => i.id === pay) : unpaid[0];
  const needsEmail = !b.owner.email;
  const choosing = b.status === 'unpaid' || b.status === 'cancelled';

  return (
    <>
      <PageHeader eyebrow="Billing" title={choosing ? 'Choose your protection' : 'Your subscription'} subtitle={choosing ? 'Pay once for the term. Protection switches on the moment your payment is confirmed.' : 'What you are on, what is due, and every invoice.'} />

      {notice === 'payment-required' && (
        <p role="status" className="mb-4 rounded-md border border-amber-500/60 px-3 py-2 text-sm text-parchment">
          That page needs an active subscription. Pay below and it opens straight away.
        </p>
      )}
      {notice === 'plan-at-renewal' && (
        <p role="status" className="mb-4 rounded-md border border-hair px-3 py-2 text-sm text-parchment">
          Your plan change is booked for the next renewal. Nothing to pay now.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-[var(--color-loss)] px-3 py-2 text-sm text-[var(--color-loss)]">
          {error}
        </p>
      )}

      <Card>
        <SubscriptionCard status={b.status} anniversaryOn={b.anniversaryOn} planName={b.planName} billedVehicles={b.billedVehicles} today={today} />
        {b.vehicles.length === 0 && (
          <p className="mt-3 text-sm text-muted">
            The price is per vehicle.{' '}
            <Link href="/owner/add-vehicle" className="text-gold-bright hover:underline">
              Add your vehicle
            </Link>{' '}
            first.
          </p>
        )}
      </Card>

      {focus && (
        <Card className="mt-4 border-gold-bright">
          <CardTitle>Payment due</CardTitle>
          <p className="mt-1 text-sm text-parchment">
            Invoice <span className="tnum text-cream">{focus.number}</span> · {formatMoney(Number(focus.gross_minor) - Number(focus.paid_minor) - Number(focus.wht_minor), { region })} · due {focus.due_on}
          </p>
          <form method="post" action="/owner/billing/pay" className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="invoice_id" value={focus.id} />
            {needsEmail && (
              <label className="block text-xs text-parchment">
                Email for your receipt
                <input name="email" type="email" required className={`${inputCls} mt-1 w-64`} />
              </label>
            )}
            <Button type="submit">Pay {formatMoney(Number(focus.gross_minor) - Number(focus.paid_minor) - Number(focus.wht_minor), { region, showMinor: false })}</Button>
            <Link href={`/owner/billing/${focus.number}`} className="text-sm text-gold-bright hover:underline">
              View invoice &amp; bank details
            </Link>
          </form>
        </Card>
      )}

      {(choosing || b.status === 'active') && b.vehicles.length > 0 && !focus && (
        <Card className="mt-4">
          <CardTitle>{choosing ? 'Plans' : 'Change plan'}</CardTitle>
          <form method="post" action="/owner/billing/pay" className="mt-3 space-y-4">
            <PlanPicker offers={offers} vehicles={b.vehicles.length} currentPlanId={b.status === 'active' ? b.planId : null} />
            <div className="flex flex-wrap items-end gap-3">
              {needsEmail && (
                <label className="block text-xs text-parchment">
                  Email for your receipt
                  <input name="email" type="email" required className={`${inputCls} mt-1 w-64`} />
                </label>
              )}
              <Button type="submit" disabled={offers.length === 0}>
                {choosing ? 'Continue to payment' : 'Change plan'}
              </Button>
            </div>
            {!choosing && <p className="text-xs text-muted">An upgrade is charged pro-rata to your renewal date and applies once paid. A downgrade takes effect at the renewal.</p>}
          </form>
        </Card>
      )}

      <Card className="mt-4">
        <CardTitle>Invoices</CardTitle>
        {b.invoices.length === 0 ? (
          <EmptyState title="No invoices yet" />
        ) : (
          <Table caption="Your invoices">
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>For</Th>
                <Th>Issued</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {b.invoices.map((i) => (
                <tr key={i.id}>
                  <Td>
                    <Link href={`/owner/billing/${i.number}`} className="tnum text-gold-bright hover:underline">
                      {i.number}
                    </Link>
                  </Td>
                  <Td>{i.kind === 'initial' ? 'First term' : i.kind === 'renewal' ? 'Renewal' : i.kind === 'addition' ? 'Added vehicle' : i.kind === 'upgrade' ? 'Upgrade' : 'One-off'}</Td>
                  <Td>{i.issued_on}</Td>
                  <Td className="tnum">{formatMoney(Number(i.gross_minor), { region })}</Td>
                  <Td>
                    <Badge tone={i.status === 'paid' ? 'profit' : i.status === 'void' ? 'neutral' : 'warn'}>{i.status === 'paid' ? 'paid' : i.status === 'void' ? 'void' : 'due'}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
