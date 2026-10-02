import {
  PageHeader,
  Card,
  CardTitle,
  Stat,
  Badge,
  Button,
  Table,
  Th,
  Td,
  EmptyState,
  Money,
} from '@/components/ui';
import { Icon } from '@/components/icons';
import { fuelByVehicle, listFuelDriverOptions, listFuelLogs, listFuelVehicleOptions } from '@/lib/fuel-log';
import { recordFuelAction } from '@/lib/actions/fuel';
import { formatDate } from '@/lib/display';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

const inputCls =
  'w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

/** Plain-English labels. The detection kinds are machine keys, not sentences. */
const ANOMALY_LABEL: Record<string, string> = {
  over_tank_capacity: 'More than the tank holds',
  consumption_worse: 'Fuel unaccounted for',
  consumption_impossible: 'Unlogged fill',
  duplicate_fill: 'Possible duplicate',
  price_spike: 'Overpaid per litre',
};

export default async function FuelPage() {
  const [vehicles, logs, vehicleOptions, driverOptions] = await Promise.all([
    fuelByVehicle(),
    listFuelLogs(200),
    listFuelVehicleOptions(),
    listFuelDriverOptions(),
  ]);

  const totalLitres = vehicles.reduce((s, v) => s + v.analysis.totalLitres, 0);
  const totalCost = vehicles.reduce((s, v) => s + v.analysis.totalCostMinor, 0);

  // Flattened so the operator sees the fleet's problems in one list, worst
  // first, rather than having to open each vehicle to discover there is one.
  const findings = vehicles
    .flatMap((v) => v.analysis.anomalies.map((a) => ({ ...a, registration: v.profile.registration })))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const missingOdometer = logs.filter((l) => l.odometerKm == null).length;

  return (
    <>
      <PageHeader
        eyebrow="Costs"
        title="Fuel"
        subtitle="Every fill, and what the litres say when compared against distance actually travelled."
      />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Litres recorded" value={Math.round(totalLitres).toLocaleString()} className="reveal" />
        <Stat label="Fuel spend" value={formatMoney(totalCost, { showMinor: false })} className="reveal" />
        <Stat label="Fills" value={logs.length} className="reveal" />
        <Stat
          label="Needs attention"
          value={highCount > 0 ? `${highCount}` : '—'}
          className="reveal"
        />
      </section>

      {/* Findings first: this is the reason the module exists. */}
      <section className="mt-4">
        <Card>
          <CardTitle>What to look at</CardTitle>
          {findings.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              Nothing unusual. Consumption is compared against each vehicle&apos;s own history, so this
              stays quiet until something genuinely departs from it.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {findings.map((f, i) => (
                <li key={`${f.logId}-${f.kind}-${i}`} className="flex items-start gap-3">
                  <span className={f.severity === 'high' ? 'text-[var(--color-loss)]' : 'text-gold-bright'}>
                    <Icon name={f.severity === 'high' ? 'alert' : 'shield'} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-cream">
                      <span className="font-medium">{f.registration}</span>{' '}
                      <Badge tone={f.severity === 'high' ? 'loss' : 'warn'}>
                        {ANOMALY_LABEL[f.kind] ?? f.kind}
                      </Badge>
                    </p>
                    <p className="mt-0.5 text-sm text-muted">{f.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Log a fill</CardTitle>
          <form action={recordFuelAction} className="mt-3 space-y-2">
            <select name="vehicle_id" aria-label="Vehicle" className={inputCls} defaultValue="" required>
              <option value="" disabled>
                Vehicle…
              </option>
              {vehicleOptions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.registration}
                </option>
              ))}
            </select>

            <select name="driver_id" aria-label="Driver" className={inputCls} defaultValue="">
              <option value="">Driver (optional)</option>
              {driverOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Litres</span>
                <input name="litres" inputMode="decimal" required placeholder="45.5" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Amount paid</span>
                <input name="cost" inputMode="decimal" required placeholder="12500" className={inputCls} />
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-parchment">Odometer (km)</span>
              <input name="odometer_km" inputMode="numeric" placeholder="82140" className={inputCls} />
              {/* Said plainly, because a blank odometer is the difference between
                  a fill that can be checked and one that can only be paid. */}
              <span className="mt-1 block text-xs text-muted">
                Optional, but without it this fill counts towards spend and nothing else — consumption
                cannot be worked out.
              </span>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Station</span>
                <input name="station" placeholder="Total, Ikeja" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Paid by</span>
                <select name="payment_method" className={inputCls} defaultValue="cash">
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="fuel_card">Fuel card</option>
                  <option value="company_account">Company account</option>
                  <option value="other">Other</option>
                </select>
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-parchment">Receipt photo</span>
              <input type="file" name="receipt" accept="image/*,application/pdf" className={inputCls} />
            </label>

            <Button type="submit" className="w-full">
              Record fill
            </Button>
          </form>
        </Card>

        <Card>
          <CardTitle>Consumption by vehicle</CardTitle>
          {vehicles.length === 0 ? (
            <EmptyState title="No vehicles yet" hint="Add vehicles to the fleet and their fuel will appear here." />
          ) : (
            <Table caption="Fuel consumption and spend for each vehicle in the fleet">
              <thead>
                <tr>
                  <Th>Vehicle</Th>
                  <Th>km / litre</Th>
                  <Th>Litres</Th>
                  <Th>Spend</Th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.profile.vehicleId}>
                    <Td>{v.profile.registration}</Td>
                    <Td>
                      {v.analysis.observedKmPerLitre == null ? (
                        <span className="text-muted">not enough data</span>
                      ) : (
                        (Math.round(v.analysis.observedKmPerLitre * 10) / 10).toFixed(1)
                      )}
                    </Td>
                    <Td>{Math.round(v.analysis.totalLitres).toLocaleString()}</Td>
                    <Td>
                      <Money pence={v.analysis.totalCostMinor} showPence={false} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      <section className="mt-4">
        <Card>
          <CardTitle>Recent fills</CardTitle>
          {missingOdometer > 0 && (
            <p className="mt-2 text-sm text-muted">
              {missingOdometer} of these {missingOdometer === 1 ? 'has' : 'have'} no odometer reading, so
              {missingOdometer === 1 ? ' it is' : ' they are'} counted in spend but cannot be checked
              against distance.
            </p>
          )}
          {logs.length === 0 ? (
            <EmptyState title="No fills recorded yet" hint="Log the first one using the form above." />
          ) : (
            <Table caption="Recent fuel fills, newest first, with vehicle, driver, litres, odometer and cost">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Vehicle</Th>
                  <Th>Driver</Th>
                  <Th>Litres</Th>
                  <Th>Odometer</Th>
                  <Th>Cost</Th>
                  <Th>Station</Th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <Td>{formatDate(l.filledAt.toISOString())}</Td>
                    <Td>{l.registration}</Td>
                    <Td>{l.driverName ?? '—'}</Td>
                    <Td>{l.litres.toFixed(1)}</Td>
                    <Td>
                      {l.odometerKm == null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        l.odometerKm.toLocaleString()
                      )}
                    </Td>
                    <Td>
                      <Money pence={l.costMinor} showPence={false} />
                    </Td>
                    <Td>{l.station ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </section>
    </>
  );
}
