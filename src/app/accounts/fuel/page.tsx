import { PageHeader, Card, Money, Table, Th, Td, EmptyState } from '@/components/ui';
import { formatDate } from '@/lib/display';
import { requireTenantContext, contextCan } from '@/lib/auth/context';
import { listFuelLogs } from '@/lib/fuel-log';

export const dynamic = 'force-dynamic';

export default async function AccountsFuelPage() {
  const ctx = await requireTenantContext();
  const canRead = contextCan(ctx, 'billing.read');
  if (!canRead) {
    return (
      <>
        <PageHeader eyebrow="Accounts" title="Fuel" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have permission to read fuel logs. Ask the ops admin to grant
            you <code>billing.read</code>.
          </p>
        </Card>
      </>
    );
  }
  const logs = await listFuelLogs(50);
  const total = logs.reduce((s, l) => s + (l.costMinor ?? 0), 0);
  return (
    <>
      <PageHeader
        eyebrow="Accounts · Fuel"
        title="Fuel log"
        subtitle={`50 most recent fills. Total of ${logs.length} entries · ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(total / 100)}`}
      />
      {logs.length === 0 ? (
        <EmptyState title="No fuel recorded yet" />
      ) : (
        <Card>
          <Table caption="Fuel log">
            <thead>
              <tr>
                <Th>Date</Th><Th>Vehicle</Th><Th>Driver</Th>
                <Th className="text-right">Litres</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <Td>{formatDate(String(l.filledAt))}</Td>
                  <Td className="font-mono text-xs">{l.vehicleId?.slice(0, 8)}… <span className="text-muted">({l.registration})</span></Td>
                  <Td className="text-xs">{l.driverName ?? '—'}</Td>
                  <Td className="text-right tnum">{l.litres?.toFixed(1) ?? '—'}</Td>
                  <Td className="text-right font-mono"><Money pence={l.costMinor ?? 0} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}