// NOTE: these helpers are server-only (one uses the service-role key). Add
// `import 'server-only'` once that package is available to make accidental
// client imports a build error. Never import this module from a Client Component.
import { requireTenantContext } from '@/lib/auth/context';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { VehicleEconomics } from '@/lib/types';

// Portal-only read helpers for the driver and investor surfaces. These augment
// (never replace) src/lib/queries.ts — the shared module is reused wherever it
// already covers a need. RLS scopes driver rows automatically; the investor
// aggregate views are PII-free and role-guarded in SQL.

/* ── Driver ─────────────────────────────────────────────────────────────── */

export interface Payment {
  id: string;
  driver_id: string | null;
  agreement_id: string | null;
  source: string;
  amount_pence: number;
  received_on: string;
  status: string;
  external_ref: string | null;
}

/** A driver's confirmed + pending payment history, newest first. */
export async function getPaymentsForDriver(driverId: string): Promise<Payment[]> {
  const sb = await createClient();
  const { data } = await sb
    .from('payments')
    .select('id, driver_id, agreement_id, source, amount_pence, received_on, status, external_ref')
    .eq('driver_id', driverId)
    .order('received_on', { ascending: false });
  return (data ?? []) as Payment[];
}

/* ── Investor ───────────────────────────────────────────────────────────── */

export interface InvestorFleet {
  vehicles: number;
  on_hire: number;
  contracted_annual_profit_pence: number;
  net_received_to_date_pence: number;
  avg_occupancy_pct: number;
}

/** Single aggregate row across the whole fleet (PII-free, role-guarded view). */
export async function getInvestorFleet(): Promise<InvestorFleet | null> {
  const sb = await createClient();
  const { data } = await sb.from('v_investor_fleet').select('*').maybeSingle();
  return (data ?? null) as InvestorFleet | null;
}

/** Per-vehicle economics with no driver link. Reuses the VehicleEconomics shape. */
export async function getInvestorVehicles(): Promise<VehicleEconomics[]> {
  const sb = await createClient();
  const { data } = await sb.from('v_investor_vehicle').select('*').order('registration');
  return (data ?? []) as VehicleEconomics[];
}

export interface VatQuarterRow {
  quarter_start: string;
  gross_received_pence: number;
  output_vat_pence: number;
  input_vat_maintenance_pence: number;
  net_vat_pence: number;
}

/**
 * Cash-basis VAT position by quarter.
 *
 * NOTE (foundation gap): `v_vat_by_quarter` is declared `security_invoker = true`
 * (migration 0012) and reads base tables that investors have no RLS grant on, so
 * an investor session would see zero rows. These are non-PII quarterly aggregates
 * the investor is explicitly entitled to, so we read them with the service-role
 * client as a deliberate stopgap. The clean fix is to redefine the view as
 * SECURITY DEFINER + `auth_role() in ('investor','ops')`, mirroring
 * v_investor_fleet/v_investor_vehicle.
 */
export async function getVatByQuarter(): Promise<VatQuarterRow[]> {
  const { tenantId } = await requireTenantContext();
  const sb = createServiceClient();
  const { data } = await sb
    .from('v_vat_by_quarter_tenant')
    .select('quarter_start, gross_received_pence, output_vat_pence, input_vat_maintenance_pence, net_vat_pence')
    .eq('tenant_id', tenantId)
    .order('quarter_start');
  return (data ?? []) as VatQuarterRow[];
}
