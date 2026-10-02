import { PageHeader, Card, Badge, Money, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getSessionProfile } from '@/lib/auth';
import { getMyActiveAgreement, getInvoicesForAgreement } from '@/lib/queries';
import { getPaymentsForDriver } from '@/lib/queries-portal';
import { formatDate, titleCase, invoiceStatusTone } from '@/lib/display';

export const dynamic = 'force-dynamic';

export default async function DriverPayments() {
  const p = await getSessionProfile();
  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Billing" title="Payments" />
        <EmptyState title="No active agreement linked to your account" />
      </>
    );
  }

  const ag = await getMyActiveAgreement(p.driverId);
  const [payments, invoices] = await Promise.all([
    getPaymentsForDriver(p.driverId),
    ag ? getInvoicesForAgreement(ag.id) : Promise.resolve([]),
  ]);

  const outstanding = invoices
    .filter((i) => i.status !== 'paid' && i.status !== 'void')
    .reduce((s, i) => s + (i.balance_pence ?? 0), 0);
  const paidToDate = payments
    .filter((pm) => pm.status === 'confirmed')
    .reduce((s, pm) => s + pm.amount_pence, 0);

  return (
    <>
      <PageHeader
        eyebrow="Billing"
        title="Payments"
        subtitle="Your rent invoices and everything you've paid."
        actions={
          ag ? (
            // Plain anchor (not next/link) so the checkout API route is never prefetched.
            <a
              href={`/api/payments/checkout?agreement=${ag.id}`}
              className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] px-3 py-1.5 text-xs font-semibold transition-all duration-200 bg-gradient-to-b from-gold-bright to-gold text-on-gold hover:brightness-110 shadow-[0_4px_18px_-6px_rgba(184,151,42,0.6)]"
            >
              <Icon name="wallet" className="h-4 w-4" /> Pay now
            </a>
          ) : undefined
        }
      />

      <section className="mb-4 grid grid-cols-2 gap-3 sm:gap-4">
        <Card className="reveal">
          <p className="eyebrow text-parchment">Outstanding</p>
          <p className={`mt-2 font-display text-3xl tnum ${outstanding > 0 ? 'text-[var(--color-loss)]' : 'text-[var(--color-profit)]'}`}>
            <Money pence={outstanding} />
          </p>
        </Card>
        <Card className="reveal">
          <p className="eyebrow text-parchment">Paid to date</p>
          <p className="mt-2 font-display text-3xl tnum text-cream"><Money pence={paidToDate} /></p>
        </Card>
      </section>

      {/* Invoices */}
      <section className="mb-6">
        <h2 className="mb-3 font-display text-xl text-cream">Invoices</h2>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices yet" hint="Your weekly rent invoices will appear here." />
        ) : (
          <Table caption="Invoices">
            <thead>
              <tr>
                <Th>Invoice</Th><Th>Issued</Th><Th>Due</Th><Th>Amount</Th><Th>Balance</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <Td className="text-cream">{i.number ?? i.id.slice(0, 8)}</Td>
                  <Td>{formatDate(i.issued_on)}</Td>
                  <Td>{formatDate(i.due_on)}</Td>
                  <Td><Money pence={i.gross_pence} /></Td>
                  <Td><Money pence={i.balance_pence ?? 0} /></Td>
                  <Td>
                    <Badge tone={i.is_overdue ? 'loss' : invoiceStatusTone(i.status)}>
                      {i.is_overdue ? 'Overdue' : titleCase(i.status)}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {/* Payment history */}
      <section>
        <h2 className="mb-3 font-display text-xl text-cream">Payment history</h2>
        {payments.length === 0 ? (
          <EmptyState title="No payments yet" hint="Once you pay, your receipts appear here." />
        ) : (
          <Table caption="Payment history">
            <thead>
              <tr>
                <Th>Date</Th><Th>Method</Th><Th>Reference</Th><Th>Amount</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((pm) => (
                <tr key={pm.id}>
                  <Td className="text-cream">{formatDate(pm.received_on)}</Td>
                  <Td>{titleCase(pm.source)}</Td>
                  <Td>{pm.external_ref ?? '—'}</Td>
                  <Td><Money pence={pm.amount_pence} /></Td>
                  <Td>
                    <Badge tone={pm.status === 'confirmed' ? 'profit' : pm.status === 'pending' ? 'warn' : 'neutral'}>
                      {titleCase(pm.status)}
                    </Badge>
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
