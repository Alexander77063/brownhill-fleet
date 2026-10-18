import { PageHeader, Card, CardTitle, Money, Table, Th, Td, EmptyState, Button } from '@/components/ui';
import { formatDate } from '@/lib/display';
import { requireTenantContext, contextCan } from '@/lib/auth/context';
import { listFuelLogs } from '@/lib/fuel-log';
import { listFuelVehicleOptions, listFuelDriverOptions } from '@/lib/fuel-log';
import { recordFuelAction } from '@/lib/actions/fuel';

export const dynamic = 'force-dynamic';

export default async function AccountsFuelPage() {
  const ctx = await requireTenantContext();
  const canRead = contextCan(ctx, 'billing.read');
  const canWrite = contextCan(ctx, 'billing.write');
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

  const [logs, vehicles, drivers] = await Promise.all([
    listFuelLogs(50),
    canWrite ? listFuelVehicleOptions() : Promise.resolve([] as Awaited<ReturnType<typeof listFuelVehicleOptions>>),
    canWrite ? listFuelDriverOptions() : Promise.resolve([] as Awaited<ReturnType<typeof listFuelDriverOptions>>),
  ]);
  const total = logs.reduce((s, l) => s + (l.costMinor ?? 0), 0);
  return (
    <>
      <PageHeader
        eyebrow="Accounts · Fuel"
        title="Fuel log"
        subtitle={`50 most recent fills. Total ${logs.length} entries · ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(total / 100)}`}
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

      {canWrite && (
        <Card className="mt-4 max-w-2xl">
          <CardTitle>Record fuel fill-up</CardTitle>
          {vehicles.length === 0 ? (
            <EmptyState title="No vehicles yet" hint="Add a vehicle at /ops/fleet first." />
          ) : (
            <form action={recordFuelAction} className="mt-4 space-y-3">
              <label className="block">
                <span className="eyebrow text-parchment">Vehicle</span>
                <select name="vehicle_id" required className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream">
                  <option value="">Select vehicle…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>{v.registration}</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="eyebrow text-parchment">Litres</span>
                  <input
                    name="litres"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="42.30"
                    className="mt-1 w-full tnum rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                  />
                </label>
                <label className="block">
                  <span className="eyebrow text-parchment">Cost (£)</span>
                  <input
                    name="cost"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="65.40"
                    className="mt-1 w-full tnum rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="eyebrow text-parchment">Filled on</span>
                  <input
                    name="filled_at"
                    type="date"
                    className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                  />
                </label>
                <label className="block">
                  <span className="eyebrow text-parchment">Odometer (km)</span>
                  <input
                    name="odometer_km"
                    type="number"
                    min="0"
                    placeholder="84210"
                    className="mt-1 w-full tnum rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
                  />
                </label>
              </div>
              {drivers.length > 0 && (
                <label className="block">
                  <span className="eyebrow text-parchment">Driver (optional)</span>
                  <select name="driver_id" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream">
                    <option value="">—</option>
                    {drivers.map((d) => (
                      <option key={d.id} value={d.id}>{d.full_name}</option>
                    ))}
                  </select>
                </label>
              )}
              <Button type="submit" className="w-full">Record fill-up</Button>
            </form>
          )}
        </Card>
      )}
    </>
  );
}