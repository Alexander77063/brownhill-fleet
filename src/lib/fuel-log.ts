/**
 * Fuel data access.
 *
 * Kept separate from `fuel.ts`, which is pure arithmetic over fills and is
 * tested exhaustively without a database. Mixing queries into that file would
 * make the detection logic — the part that decides whether someone is accused
 * of stealing fuel — expensive to test and therefore less tested.
 */
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  analyseFuel,
  type FuelAnalysis,
  type FuelLog,
  type FuelPaymentMethod,
  type VehicleFuelProfile,
} from '@/lib/fuel';

export interface FuelLogRow extends FuelLog {
  registration: string;
  driverName: string | null;
  paymentMethod: string;
  note: string | null;
}

export interface RecordFuelInput {
  vehicleId: string;
  driverId: string | null;
  litres: number;
  costMinor: number;
  odometerKm: number | null;
  filledAt?: string;
  station?: string | null;
  paymentMethod?: FuelPaymentMethod;
  note?: string | null;
  receiptPath?: string | null;
}

/** Record a refuel. */
export async function recordFuelLog(
  tenantId: string,
  input: RecordFuelInput,
  actor: string | null,
): Promise<{ id: string }> {
  const sb = await createClient();
  const { data, error } = await sb
    .from('fuel_logs')
    .insert({
      // Set explicitly rather than relying on a column default: every write in
      // this codebase names its tenant, so a row can never be attributed by
      // whatever the database happened to default to.
      tenant_id: tenantId,
      vehicle_id: input.vehicleId,
      driver_id: input.driverId,
      litres: input.litres,
      cost_minor: input.costMinor,
      odometer_km: input.odometerKm,
      filled_at: input.filledAt || new Date().toISOString(),
      station: input.station ?? null,
      payment_method: input.paymentMethod ?? 'cash',
      note: input.note ?? null,
      receipt_path: input.receiptPath ?? null,
      logged_by: actor,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Could not record the fuel entry: ${error.message}`);
  return { id: (data as { id: string }).id };
}

interface RawRow {
  id: string;
  vehicle_id: string;
  driver_id: string | null;
  filled_at: string;
  litres: string | number;
  cost_minor: string | number;
  odometer_km: number | null;
  station: string | null;
  payment_method: string;
  note: string | null;
  vehicles?: { registration?: string } | null;
  drivers?: { full_name?: string } | null;
}

/**
 * Postgres returns `numeric` as a string to preserve precision, so litres and
 * cost arrive as text. Converting here rather than at each call site means the
 * analysis never has to wonder which it got.
 */
function toLog(r: RawRow): FuelLogRow {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    driverId: r.driver_id,
    filledAt: new Date(r.filled_at),
    litres: Number(r.litres),
    costMinor: Number(r.cost_minor),
    odometerKm: r.odometer_km,
    station: r.station,
    registration: r.vehicles?.registration ?? '—',
    driverName: r.drivers?.full_name ?? null,
    paymentMethod: r.payment_method,
    note: r.note,
  };
}

/** Recent fills across the fleet, newest first. */
export async function listFuelLogs(limit = 200): Promise<FuelLogRow[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('fuel_logs')
    .select(
      'id, vehicle_id, driver_id, filled_at, litres, cost_minor, odometer_km, station, payment_method, note, vehicles(registration), drivers(full_name)',
    )
    .order('filled_at', { ascending: false })
    .limit(limit);

  return ((data ?? []) as unknown as RawRow[]).map(toLog);
}

export interface VehicleFuelView {
  profile: VehicleFuelProfile;
  analysis: FuelAnalysis;
}

/**
 * One vehicle's fuel analysis over a date range, for the monthly owner report.
 *
 * Service client (the report is assembled by a cron with no session), scoped
 * by tenant and vehicle, and date-ranged — unlike `fuelByVehicle`, which is the
 * signed-in operator's fleet-wide view.
 */
export async function fuelForVehicle(
  sb: ReturnType<typeof createServiceClient>,
  tenantId: string,
  vehicleId: string,
  fromIso: string,
  toIso: string,
): Promise<FuelAnalysis> {
  const [{ data: v }, { data }] = await Promise.all([
    sb.from('vehicles').select('id, registration, tank_capacity_litres, baseline_km_per_litre').eq('tenant_id', tenantId).eq('id', vehicleId).maybeSingle(),
    sb
      .from('fuel_logs')
      .select('id, vehicle_id, driver_id, filled_at, litres, cost_minor, odometer_km, station, payment_method, note')
      .eq('tenant_id', tenantId)
      .eq('vehicle_id', vehicleId)
      .gte('filled_at', fromIso)
      .lt('filled_at', toIso)
      .order('filled_at', { ascending: true }),
  ]);
  const profile: VehicleFuelProfile = {
    vehicleId,
    registration: (v as { registration?: string } | null)?.registration ?? '—',
    tankCapacityLitres: v?.tank_capacity_litres == null ? null : Number(v.tank_capacity_litres),
    baselineKmPerLitre: v?.baseline_km_per_litre == null ? null : Number(v.baseline_km_per_litre),
  };
  return analyseFuel(profile, ((data ?? []) as unknown as RawRow[]).map(toLog));
}

/**
 * Every vehicle with its own fuel analysis.
 *
 * One query for vehicles and one for fills, then grouped in memory: a per-vehicle
 * query would be a round trip per row, and a fleet is small enough that this is
 * cheaper than the alternative by a wide margin.
 */
export async function fuelByVehicle(): Promise<VehicleFuelView[]> {
  const sb = await createClient();

  const [{ data: vehicles }, logs] = await Promise.all([
    sb
      .from('vehicles')
      .select('id, registration, tank_capacity_litres, baseline_km_per_litre')
      .order('registration'),
    listFuelLogs(1000),
  ]);

  const byVehicle = new Map<string, FuelLogRow[]>();
  for (const log of logs) {
    const list = byVehicle.get(log.vehicleId);
    if (list) list.push(log);
    else byVehicle.set(log.vehicleId, [log]);
  }

  type V = { id: string; registration: string; tank_capacity_litres: string | null; baseline_km_per_litre: string | null };

  return ((vehicles ?? []) as V[]).map((v) => {
    const profile: VehicleFuelProfile = {
      vehicleId: v.id,
      registration: v.registration,
      tankCapacityLitres: v.tank_capacity_litres == null ? null : Number(v.tank_capacity_litres),
      baselineKmPerLitre: v.baseline_km_per_litre == null ? null : Number(v.baseline_km_per_litre),
    };
    return { profile, analysis: analyseFuel(profile, byVehicle.get(v.id) ?? []) };
  });
}

/** Vehicles for the log-a-fill dropdown. */
export async function listFuelVehicleOptions(): Promise<{ id: string; registration: string }[]> {
  const sb = await createClient();
  const { data } = await sb.from('vehicles').select('id, registration').order('registration');
  return (data ?? []) as { id: string; registration: string }[];
}

/** Drivers for the log-a-fill dropdown. */
export async function listFuelDriverOptions(): Promise<{ id: string; full_name: string }[]> {
  const sb = await createClient();
  const { data } = await sb.from('drivers').select('id, full_name').order('full_name');
  return (data ?? []) as { id: string; full_name: string }[];
}
