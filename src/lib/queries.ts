import { createClient } from '@/lib/supabase/server';
import type {
  Vehicle, Driver, Agreement, Obligation, Charge, Invoice,
  VehicleEconomics, RtbEquityRow, InsuranceCertificate, FinanceAgreement,
} from '@/lib/types';

// Thin, typed read helpers shared by all server components. RLS scopes the
// rows automatically to the calling user's role.

export async function getVehicles(): Promise<Vehicle[]> {
  const sb = await createClient();
  const { data } = await sb.from('vehicles').select('*').order('registration');
  return (data ?? []) as Vehicle[];
}

export async function getVehicle(id: string): Promise<Vehicle | null> {
  const sb = await createClient();
  const { data } = await sb.from('vehicles').select('*').eq('id', id).maybeSingle();
  return (data ?? null) as Vehicle | null;
}

export async function getFinanceForVehicle(vehicleId: string): Promise<FinanceAgreement | null> {
  const sb = await createClient();
  const { data } = await sb.from('finance_agreements').select('*').eq('vehicle_id', vehicleId).maybeSingle();
  return (data ?? null) as FinanceAgreement | null;
}

export async function getDrivers(): Promise<Driver[]> {
  const sb = await createClient();
  const { data } = await sb.from('drivers').select('*').order('full_name');
  return (data ?? []) as Driver[];
}

export async function getDriver(id: string): Promise<Driver | null> {
  const sb = await createClient();
  const { data } = await sb.from('drivers').select('*').eq('id', id).maybeSingle();
  return (data ?? null) as Driver | null;
}

export async function getAgreements(): Promise<Agreement[]> {
  const sb = await createClient();
  const { data } = await sb.from('agreements').select('*').order('start_date', { ascending: false });
  return (data ?? []) as Agreement[];
}

export async function getAgreement(id: string): Promise<Agreement | null> {
  const sb = await createClient();
  const { data } = await sb.from('agreements').select('*').eq('id', id).maybeSingle();
  return (data ?? null) as Agreement | null;
}

export async function getFleetEconomics(): Promise<VehicleEconomics[]> {
  const sb = await createClient();
  const { data } = await sb.from('v_vehicle_economics').select('*').order('registration');
  return (data ?? []) as VehicleEconomics[];
}

export async function getObligations(): Promise<Obligation[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('obligations')
    .select('*')
    .in('status', ['open', 'due_soon', 'overdue'])
    .order('due_date');
  return (data ?? []) as Obligation[];
}

export async function getCharges(): Promise<Charge[]> {
  const sb = await createClient();
  const { data } = await sb.from('charges').select('*').order('received_on', { ascending: false });
  return (data ?? []) as Charge[];
}

export interface ArrearsRow {
  agreement_id: string;
  vehicle_id: string;
  driver_id: string;
  billed_pence: number;
  collected_pence: number;
  outstanding_pence: number;
}

export async function getArrears(): Promise<ArrearsRow[]> {
  const sb = await createClient();
  const { data } = await sb.from('v_agreement_arrears').select('*');
  return (data ?? []) as ArrearsRow[];
}

export async function getInvoicesForAgreement(agreementId: string): Promise<Invoice[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('v_invoice_balance')
    .select('*')
    .eq('agreement_id', agreementId)
    .order('issued_on', { ascending: false });
  return (data ?? []) as Invoice[];
}

export async function getEquityForAgreement(agreementId: string): Promise<RtbEquityRow[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('rtb_equity_ledger')
    .select('*')
    .eq('agreement_id', agreementId)
    .order('week_no');
  return (data ?? []) as RtbEquityRow[];
}

export async function getCertificates(): Promise<InsuranceCertificate[]> {
  const sb = await createClient();
  const { data } = await sb.from('insurance_certificates').select('*').order('cover_to');
  return (data ?? []) as InsuranceCertificate[];
}

/** For driver portal: the signed-in driver's active agreement (+ vehicle). */
export async function getMyActiveAgreement(driverId: string): Promise<(Agreement & { vehicle?: Vehicle }) | null> {
  const sb = await createClient();
  const { data } = await sb
    .from('agreements')
    .select('*')
    .eq('driver_id', driverId)
    .order('status')
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const ag = data as Agreement;
  const vehicle = (await getVehicle(ag.vehicle_id)) ?? undefined;
  return { ...ag, vehicle };
}

/** Maps of id → display label, for joining without nested selects. */
export async function getLookups() {
  const [vehicles, drivers] = await Promise.all([getVehicles(), getDrivers()]);
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  return { vehicleById, driverById, vehicles, drivers };
}
