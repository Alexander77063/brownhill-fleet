import { createClient } from '@/lib/supabase/server';
import type { Agreement, Charge, FinanceAgreement, InsuranceCertificate, Invoice } from '@/lib/types';

/* ── Finance agreements (company funder finance) ─────────────────────────── */
export async function getFinanceAgreements(): Promise<FinanceAgreement[]> {
  const sb = await createClient();
  const { data } = await sb.from('finance_agreements').select('*');
  return (data ?? []) as FinanceAgreement[];
}

// Additional read helpers for the OPS portal. The shared queries.ts covers the
// common reads; these cover ops-only tables/views (maintenance, voids, payments,
// VAT-by-quarter, investor mirrors). RLS scopes rows to the ops role.

/* ── Maintenance & voids ─────────────────────────────────────────────────── */
export interface MaintenanceRecord {
  id: string;
  vehicle_id: string;
  payer: 'company' | 'driver';
  description: string;
  cost_pence: number;
  service_on: string;
  odometer_miles: number | null;
}

export interface VoidEvent {
  id: string;
  vehicle_id: string;
  reason: string;
  start_on: string;
  end_on: string | null;
}

export async function getMaintenanceRecords(): Promise<MaintenanceRecord[]> {
  const sb = await createClient();
  const { data } = await sb.from('maintenance_records').select('*').order('service_on', { ascending: false });
  return (data ?? []) as MaintenanceRecord[];
}

export async function getMaintenanceForVehicle(vehicleId: string): Promise<MaintenanceRecord[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('maintenance_records')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('service_on', { ascending: false });
  return (data ?? []) as MaintenanceRecord[];
}

export async function getVoidEvents(): Promise<VoidEvent[]> {
  const sb = await createClient();
  const { data } = await sb.from('void_events').select('*').order('start_on', { ascending: false });
  return (data ?? []) as VoidEvent[];
}

export async function getVoidsForVehicle(vehicleId: string): Promise<VoidEvent[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('void_events')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('start_on', { ascending: false });
  return (data ?? []) as VoidEvent[];
}

/* ── Charges scoped to an entity ─────────────────────────────────────────── */
export async function getChargesForVehicle(vehicleId: string): Promise<Charge[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('charges')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('received_on', { ascending: false });
  return (data ?? []) as Charge[];
}

export async function getChargesForDriver(driverId: string): Promise<Charge[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('charges')
    .select('*')
    .eq('driver_id', driverId)
    .order('received_on', { ascending: false });
  return (data ?? []) as Charge[];
}

/* ── Payments ────────────────────────────────────────────────────────────── */
export interface Payment {
  id: string;
  driver_id: string | null;
  agreement_id: string | null;
  source: string;
  idempotency_key: string;
  amount_pence: number;
  received_on: string;
  status: string;
  external_ref: string | null;
}

export async function getRecentPayments(limit = 20): Promise<Payment[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('payments')
    .select('*')
    .order('received_on', { ascending: false })
    .limit(limit);
  return (data ?? []) as Payment[];
}

export async function getPaymentsForDriver(driverId: string): Promise<Payment[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('payments')
    .select('*')
    .eq('driver_id', driverId)
    .order('received_on', { ascending: false });
  return (data ?? []) as Payment[];
}

/* ── Insurance certificates for a driver ─────────────────────────────────── */
export async function getCertificatesForDriver(driverId: string): Promise<InsuranceCertificate[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('insurance_certificates')
    .select('*')
    .eq('driver_id', driverId)
    .order('cover_to', { ascending: false });
  return (data ?? []) as InsuranceCertificate[];
}

/* ── Agreements scoped to an entity ──────────────────────────────────────── */
export async function getActiveAgreementForVehicle(vehicleId: string): Promise<Agreement | null> {
  const sb = await createClient();
  const { data } = await sb
    .from('agreements')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .eq('status', 'active')
    .maybeSingle();
  return (data ?? null) as Agreement | null;
}

export async function getAgreementsForDriver(driverId: string): Promise<Agreement[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('agreements')
    .select('*')
    .eq('driver_id', driverId)
    .order('start_date', { ascending: false });
  return (data ?? []) as Agreement[];
}

/* ── Invoices for an agreement (open, oldest first) ──────────────────────── */
export async function getOpenInvoicesForAgreement(agreementId: string): Promise<Invoice[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('v_invoice_balance')
    .select('*')
    .eq('agreement_id', agreementId)
    .order('due_on', { ascending: true });
  return (data ?? []) as Invoice[];
}

/* ── Cash-basis VAT by quarter ───────────────────────────────────────────── */
export interface VatQuarter {
  quarter_start: string;
  gross_received_pence: number;
  output_vat_pence: number;
  input_vat_maintenance_pence: number;
  net_vat_pence: number;
}

export async function getVatByQuarter(): Promise<VatQuarter[]> {
  const sb = await createClient();
  const { data } = await sb.from('v_vat_by_quarter').select('*').order('quarter_start', { ascending: false });
  return (data ?? []) as VatQuarter[];
}

/* ── Investor mirror views ───────────────────────────────────────────────── */
export interface InvestorFleet {
  vehicles: number;
  on_hire: number;
  contracted_annual_profit_pence: number;
  net_received_to_date_pence: number;
  avg_occupancy_pct: number;
}

export interface InvestorVehicle {
  vehicle_id: string;
  registration: string;
  status: string;
  agreement_type: 'standard' | 'rtb' | null;
  contracted_annual_net_pence: number | null;
  annual_lease_pence: number;
  maintenance_12m_pence: number;
  ved_annual_pence: number;
  contracted_annual_profit_pence: number | null;
  net_received_to_date_pence: number;
  occupancy_12m_pct: number;
  gfv_status: string;
  gfv_due_on: string | null;
}

export async function getInvestorFleet(): Promise<InvestorFleet | null> {
  const sb = await createClient();
  const { data } = await sb.from('v_investor_fleet').select('*').maybeSingle();
  return (data ?? null) as InvestorFleet | null;
}

export async function getInvestorVehicles(): Promise<InvestorVehicle[]> {
  const sb = await createClient();
  const { data } = await sb.from('v_investor_vehicle').select('*').order('registration');
  return (data ?? []) as InvestorVehicle[];
}
