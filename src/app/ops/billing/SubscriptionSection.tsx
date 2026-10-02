import Link from 'next/link';
import { Card, CardTitle, Badge, Table, Th, Td, EmptyState } from '@/components/ui';
import { SubscriptionCard } from '@/components/collection/SubscriptionCard';
import { requireTenantContext } from '@/lib/auth/context';
import { listInvoices, todayISO, UNPAID_STATUSES } from '@/lib/collection/invoices';
import type { SubStatus } from '@/lib/collection/state';
import { deploymentProfile } from '@/lib/deployment/profile';
import { formatMoney } from '@/lib/money';
import { createServiceClient } from '@/lib/supabase/server';

/** A fleet's or insurer's own subscription to us: status, renewal, invoices, how to pay. */
export async function SubscriptionSection() {
  const ctx = await requireTenantContext();
  const sb = createServiceClient();
  const region = deploymentProfile().region;
  const [{ data: sub }, invoices] = await Promise.all([
    sb.from('tenant_subscription').select('status, anniversary_on, billed_vehicles, plans(name)').eq('tenant_id', ctx.tenantId).maybeSingle(),
    listInvoices(ctx.tenantId, sb),
  ]);
  const plan = (sub as unknown as { plans: { name: string } | null } | null)?.plans ?? null;
  const status = ((sub?.status as SubStatus | undefined) ?? 'unpaid') as SubStatus;
  const open = invoices.filter((i) => UNPAID_STATUSES.includes(i.status));
  const outstanding = open.reduce((s, i) => s + Number(i.gross_minor) - Number(i.paid_minor) - Number(i.wht_minor), 0);

  return (
    <section className="mb-6 space-y-4">
      <Card>
        <CardTitle>Your subscription</CardTitle>
        <div className="mt-3">
          <SubscriptionCard status={status} anniversaryOn={sub?.anniversary_on ?? null} planName={plan?.name ?? null} billedVehicles={sub?.billed_vehicles ?? 0} today={todayISO()} />
        </div>
        {status === 'unpaid' && (
          <p className="mt-3 text-sm text-parchment">
            Protection starts when the first invoice is paid. {open.length ? 'Your invoice is below.' : 'Your account manager will issue the first invoice once your vehicles are loaded.'}
          </p>
        )}
        {open.length > 0 && (
          <p className="mt-3 text-sm text-parchment">
            Outstanding: <span className="tnum text-cream">{formatMoney(outstanding, { region })}</span>. Pay online from the invoice link, or transfer to the account shown on it quoting the invoice number.
          </p>
        )}
      </Card>
      <Card>
        <CardTitle>Invoices from us</CardTitle>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices yet" />
        ) : (
          <Table caption="Subscription invoices">
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Kind</Th>
                <Th>Issued</Th>
                <Th>Due</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <Td className="tnum">{i.number}</Td>
                  <Td>{i.kind.replace('_', ' ')}</Td>
                  <Td>{i.issued_on}</Td>
                  <Td>{i.due_on}</Td>
                  <Td className="tnum">{formatMoney(Number(i.gross_minor), { region })}</Td>
                  <Td>
                    <Badge tone={i.status === 'paid' ? 'profit' : i.status === 'void' ? 'neutral' : i.status === 'overdue' ? 'loss' : 'warn'}>{i.status.replace('_', ' ')}</Badge>
                  </Td>
                  <Td>
                    <Link href={`/pay/${i.pay_token}`} className="text-sm text-gold-bright hover:underline">
                      {UNPAID_STATUSES.includes(i.status) ? 'View & pay' : 'View'}
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </section>
  );
}
