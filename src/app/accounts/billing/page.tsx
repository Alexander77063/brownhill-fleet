import { PageHeader, Card, CardTitle, Money, Table, Th, Td, EmptyState } from '@/components/ui';
import { getArrears } from '@/lib/queries';
import { requireTenantContext, contextCan } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

/**
 * /accounts/billing — read-only arrears view for the accountant.
 * Edit access (billing.write / payments.record) lives at /ops/billing; this
 * stays read-only when only billing.read is granted.
 */
export default async function AccountsBillingPage() {
  const ctx = await requireTenantContext();
  const canRead = contextCan(ctx, 'billing.read');
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
  const arrears = await getArrears();
  const total = arrears.reduce((s, a) => s + (a.outstanding_pence ?? 0), 0);
  return (
    <>
      <PageHeader
        eyebrow="Accounts · Billing"
        title="Arrears"
        subtitle="Outstanding balances per agreement. For full statements and payment recording, see /ops/billing."
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
                  <Td className="font-mono text-xs text-muted">{a.driver_id.slice(0, 8)}…</Td>
                  <Td className="font-mono text-xs text-muted">{a.vehicle_id.slice(0, 8)}…</Td>
                  <Td className="text-right font-mono"><Money pence={a.billed_pence ?? 0} /></Td>
                  <Td className="text-right font-mono"><Money pence={a.collected_pence ?? 0} /></Td>
                  <Td className="text-right font-mono text-[var(--color-loss)]"><Money pence={a.outstanding_pence ?? 0} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}