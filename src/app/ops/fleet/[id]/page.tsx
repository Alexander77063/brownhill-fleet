import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getVehicle, getFinanceForVehicle } from '@/lib/queries';
import {
  getActiveAgreementForVehicle,
  getMaintenanceForVehicle,
  getVoidsForVehicle,
  getChargesForVehicle,
} from '@/lib/queries-ops';
import { getLatestTelemetry, getVehicleDevice } from '@/lib/gps';
import { getImmobilisationState } from '@/lib/immobilise';
import { hasEntitlement } from '@/lib/entitlements';
import { requireTenantContext } from '@/lib/auth/context';
import { VehicleMap } from '@/components/VehicleMap';
import { VehicleTrackingPanel } from '@/components/ops/VehicleTrackingPanel';
import { VehicleComplianceCard } from '@/components/ops/VehicleComplianceCard';
import { buildComplianceView } from '@/lib/compliance-view';
import { getVehicleCompliance } from '@/lib/vehicle-compliance';
import { regionProvider } from '@/lib/region';
import { gfvScenarios, remainingBalanceAfter } from '@/lib/finance';
import {
  formatDate, titleCase, vehicleStatusTone, gfvTone, agreementStatusTone, chargeStatusTone,
} from '@/lib/display';

export const dynamic = 'force-dynamic';

function Spec({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-t border-hair-soft py-2.5 first:border-t-0">
      <p className="eyebrow text-parchment">{label}</p>
      <p className="mt-1 text-sm text-cream">{value}</p>
    </div>
  );
}

export default async function VehicleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const vehicle = await getVehicle(id);
  if (!vehicle) notFound();

  const { tenantId } = await requireTenantContext();
  const [
    finance, agreement, maintenance, voids, charges, telemetry, device, immob,
    complianceRecords,
    canPhone, canHardware, canImmobilise,
  ] = await Promise.all([
    getFinanceForVehicle(id),
    getActiveAgreementForVehicle(id),
    getMaintenanceForVehicle(id),
    getVoidsForVehicle(id),
    getChargesForVehicle(id),
    getLatestTelemetry(id),
    getVehicleDevice(tenantId, id),
    getImmobilisationState(tenantId, id),
    getVehicleCompliance(id),
    hasEntitlement('gps.phone'),
    hasEntitlement('gps.hardware'),
    hasEntitlement('gps.immobilise'),
  ]);

  const complianceRows = buildComplianceView(
    regionProvider().vehicleCompliance,
    complianceRecords,
    // MOT and vehicle tax still live on the vehicle row — the agreement PDF and
    // the CSV importer read those columns — so they are passed in rather than
    // duplicated into vehicle_compliance.
    { mot_due_on: vehicle.mot_due_on, ved_renewal_on: vehicle.ved_renewal_on },
    new Date().toISOString().slice(0, 10),
  );

  // 3-year gross margin (simplified): weekly net × 52 × 3 − lease × 36 months − VED × 3.
  const weeklyNet = agreement?.weekly_net_pence ?? 0;
  const monthlyLease = finance?.monthly_payment_pence ?? 0;
  const threeYearGross = weeklyNet * 52 * 3 - monthlyLease * 36 - vehicle.ved_annual_pence * 3;

  // GFV scenarios around the funder's stated GFV (±15%).
  const baseGfv = finance?.gfv_amount_pence ?? 0;
  const gfvOptions = baseGfv > 0 ? [Math.round(baseGfv * 0.85), baseGfv, Math.round(baseGfv * 1.15)] : [];
  const scenarios = gfvOptions.length ? gfvScenarios(threeYearGross, gfvOptions) : [];

  const remainingAt36 = finance && finance.amount_financed_pence
    ? remainingBalanceAfter(finance.amount_financed_pence, finance.apr, finance.monthly_payment_pence, 36)
    : null;

  return (
    <>
      <PageHeader
        eyebrow="Fleet · Vehicle"
        title={vehicle.registration}
        subtitle={`${vehicle.make} ${vehicle.model}${vehicle.model_year ? ` · ${vehicle.model_year}` : ''}`}
        actions={<Button href="/ops/fleet" variant="ghost" size="sm"><Icon name="chevron" className="h-4 w-4 rotate-180" /> Fleet</Button>}
      />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Status" value={<Badge tone={vehicleStatusTone(vehicle.status)}>{titleCase(vehicle.status)}</Badge>} className="reveal" />
        <Stat label="List value" value={<Money pence={vehicle.list_value_pence} showPence={false} />} tone="gold" className="reveal" />
        <Stat label="Annual VED" value={<Money pence={vehicle.ved_annual_pence} />} className="reveal" />
        <Stat label="3yr gross margin" value={<Money pence={threeYearGross} showPence={false} signed />} className="reveal" />
      </section>

      {telemetry?.lat != null && telemetry?.lng != null && (
        <section className="mt-4">
          <Card>
            <CardTitle>Live location</CardTitle>
            <p className="mb-3 mt-1 text-xs text-muted">
              Latest known position{telemetry.recorded_at ? ` · ${formatDate(telemetry.recorded_at)}` : ''}.
            </p>
            <VehicleMap lat={telemetry.lat} lng={telemetry.lng} label={vehicle.registration} />
            {/* Text equivalent for the canvas map (WCAG 1.1.1): a rendered map conveys
                nothing to a screen reader, so the same position is available as
                coordinates and an external link, mirroring the /ops/tracking table. */}
            <p className="mt-3 text-xs text-muted">
              Coordinates:{' '}
              <a
                href={`https://www.openstreetmap.org/?mlat=${telemetry.lat}&mlon=${telemetry.lng}#map=15/${telemetry.lat}/${telemetry.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-gold-bright hover:underline"
              >
                {telemetry.lat.toFixed(5)}, {telemetry.lng.toFixed(5)}
              </a>{' '}
              — opens in OpenStreetMap
            </p>
          </Card>
        </section>
      )}

      <section className="mt-4">
        <VehicleTrackingPanel
          vehicleId={id}
          canPhone={canPhone}
          canHardware={canHardware}
          canImmobilise={canImmobilise}
          device={
            device
              ? {
                  kind: device.kind,
                  label: device.label,
                  is_active: device.is_active,
                  state: device.state,
                  imei: device.unit?.imei ?? null,
                  fittedAt: device.fitted_at,
                  warrantyUntil: device.warranty_until,
                  firstPingAt: device.first_ping_at,
                  hasImmobiliser: device.unit?.has_immobiliser ?? false,
                }
              : null
          }
          immob={{ requested: immob.requested, status: immob.status, hardwareConnected: immob.hardwareConnected, unavailableReason: immob.unavailableReason }}
        />
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Specification */}
        <Card>
          <CardTitle>Specification</CardTitle>
          <div className="mt-3">
            <Spec label="Registration" value={vehicle.registration} />
            <Spec label="Make / Model" value={`${vehicle.make} ${vehicle.model}`} />
            <Spec label="Colour" value={vehicle.colour ?? '—'} />
            <Spec label="Model year" value={vehicle.model_year ?? '—'} />
            <Spec label="CO₂" value={vehicle.co2_gkm != null ? `${vehicle.co2_gkm} g/km` : '—'} />
            <Spec label="Acquired" value={formatDate(vehicle.acquired_on)} />
            {telemetry?.odometer_miles != null && (
              <Spec label="Odometer" value={`${telemetry.odometer_miles.toLocaleString()} mi`} />
            )}
            {vehicle.fuel === 'ev' && telemetry?.battery_pct != null && (
              <Spec label="Battery" value={`${Math.round(telemetry.battery_pct)}%`} />
            )}
            {vehicle.fuel === 'ev' && telemetry?.range_miles != null && (
              <Spec label="Range" value={`${telemetry.range_miles} mi`} />
            )}
            {vehicle.service_interval_miles != null && (
              <Spec label="Service interval" value={`${vehicle.service_interval_miles.toLocaleString()} mi`} />
            )}
          </div>
        </Card>

        {/* Finance agreement */}
        <Card>
          <CardTitle>Company finance</CardTitle>
          {finance ? (
            <div className="mt-3">
              <Spec label="Funder" value={finance.funder ?? '—'} />
              <Spec label="Monthly payment" value={<Money pence={finance.monthly_payment_pence} />} />
              <Spec label="Initial rental" value={<Money pence={finance.initial_rental_pence} />} />
              <Spec label="APR" value={`${finance.apr}%`} />
              <Spec label="Term" value={`${finance.term_months} months`} />
              <Spec label="Amount financed" value={finance.amount_financed_pence != null ? <Money pence={finance.amount_financed_pence} /> : '—'} />
              <Spec label="GFV / balloon" value={finance.gfv_amount_pence != null ? <Money pence={finance.gfv_amount_pence} /> : '—'} />
              <Spec label="GFV status" value={<Badge tone={gfvTone(finance.gfv_status)}>{titleCase(finance.gfv_status)}</Badge>} />
              <Spec label="GFV due" value={formatDate(finance.gfv_due_on)} />
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No finance agreement recorded.</p>
          )}
        </Card>

        {/* Amortization + active agreement */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>Amortization</CardTitle>
            {remainingAt36 != null ? (
              <div className="mt-3 space-y-3">
                <div>
                  <p className="eyebrow text-parchment">Balance after 36 months</p>
                  <p className="mt-1 font-display text-2xl tnum text-cream"><Money pence={remainingAt36} /></p>
                </div>
                {baseGfv > 0 && (
                  <div className="border-t border-hair-soft pt-3">
                    <p className="eyebrow text-parchment">vs funder GFV</p>
                    <p className="mt-1 text-sm tnum text-parchment">
                      <Money pence={remainingAt36 - baseGfv} signed /> {remainingAt36 - baseGfv > 0 ? 'shortfall' : 'cushion'}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">Amount financed not set.</p>
            )}
          </Card>

          <Card>
            <CardTitle>Active agreement</CardTitle>
            {agreement ? (
              <div className="mt-3">
                <Spec label="Type" value={agreement.type === 'rtb' ? 'Rent-to-Buy' : 'Standard'} />
                <Spec label="Status" value={<Badge tone={agreementStatusTone(agreement.status)}>{titleCase(agreement.status)}</Badge>} />
                <Spec label="Weekly (net)" value={<Money pence={agreement.weekly_net_pence} />} />
                <Spec label="Start" value={formatDate(agreement.start_date)} />
                <Button href={`/ops/agreements/${agreement.id}`} variant="outline" size="sm" className="mt-3 w-full">
                  View agreement
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No active agreement.</p>
            )}
          </Card>
        </div>
      </section>

      <section className="mt-4">
        <VehicleComplianceCard vehicleId={id} rows={complianceRows} />
      </section>

      {/* GFV scenarios */}
      {scenarios.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-3 font-display text-xl text-cream">GFV settlement scenarios</h2>
          <Table caption="GFV settlement scenarios">
            <thead>
              <tr>
                <Th>Scenario</Th>
                <Th className="text-right">GFV / balloon</Th>
                <Th className="text-right">3yr gross</Th>
                <Th className="text-right">Net after settlement</Th>
                <Th>Viable</Th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s, i) => (
                <tr key={s.gfvPence}>
                  <Td className="text-cream">{['Optimistic (−15%)', 'Funder GFV', 'Pessimistic (+15%)'][i] ?? `Scenario ${i + 1}`}</Td>
                  <Td className="text-right"><Money pence={s.gfvPence} showPence={false} /></Td>
                  <Td className="text-right"><Money pence={threeYearGross} showPence={false} /></Td>
                  <Td className="text-right"><Money pence={s.netAfterSettlementPence} showPence={false} signed /></Td>
                  <Td><Badge tone={s.viable ? 'profit' : 'loss'}>{s.viable ? 'Viable' : 'At risk'}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Maintenance history */}
        <div>
          <h2 className="mb-3 font-display text-xl text-cream">Maintenance</h2>
          {maintenance.length === 0 ? (
            <EmptyState title="No maintenance recorded" />
          ) : (
            <Table caption="Maintenance">
              <thead>
                <tr><Th>Date</Th><Th>Description</Th><Th>Payer</Th><Th className="text-right">Cost</Th></tr>
              </thead>
              <tbody>
                {maintenance.map((m) => (
                  <tr key={m.id}>
                    <Td>{formatDate(m.service_on)}</Td>
                    <Td className="whitespace-normal text-cream">{m.description}</Td>
                    <Td><Badge tone={m.payer === 'company' ? 'loss' : 'neutral'}>{titleCase(m.payer)}</Badge></Td>
                    <Td className="text-right"><Money pence={m.cost_pence} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {/* Void history */}
        <div>
          <h2 className="mb-3 font-display text-xl text-cream">Off-road / void events</h2>
          {voids.length === 0 ? (
            <EmptyState title="No void events" />
          ) : (
            <Table caption="Off-road and void events">
              <thead>
                <tr><Th>From</Th><Th>To</Th><Th>Reason</Th></tr>
              </thead>
              <tbody>
                {voids.map((v) => (
                  <tr key={v.id}>
                    <Td>{formatDate(v.start_on)}</Td>
                    <Td>{v.end_on ? formatDate(v.end_on) : <Badge tone="warn">Ongoing</Badge>}</Td>
                    <Td className="whitespace-normal text-cream">{v.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </section>

      {/* Charges */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Charges</h2>
        {charges.length === 0 ? (
          <EmptyState title="No charges for this vehicle" />
        ) : (
          <Table caption="Charges">
            <thead>
              <tr><Th>Date</Th><Th>Type</Th><Th>Authority</Th><Th>Ref</Th><Th className="text-right">Amount</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.id}>
                  <Td>{formatDate(c.received_on)}</Td>
                  <Td className="text-cream">{c.type.toUpperCase()}</Td>
                  <Td>{c.authority ?? '—'}</Td>
                  <Td>{c.reference ?? '—'}</Td>
                  <Td className="text-right"><Money pence={c.amount_pence} /></Td>
                  <Td><Badge tone={chargeStatusTone(c.status)}>{titleCase(c.status)}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
