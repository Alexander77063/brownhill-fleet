/**
 * Charge reconciliation — recovering pass-through charges (congestion, ULEZ,
 * airport drop-off, tolls, PCNs) from the drivers who incurred them. Surfaces what
 * each driver owes and what's still unassigned, and lets ops mark a charge
 * recovered. (Auto-matching a charge to a driver via GPS/booking comes in Phase 3;
 * this is the manual reconciliation ledger it will feed.)
 */

import { createServiceClient } from '@/lib/supabase/server';

// A charge is "outstanding" (recoverable) until it's been paid or written off.
const OPEN_STATUSES = ['received', 'driver_notified', 'driver_liable', 'disputed'] as const;

export interface DriverRecovery {
  driver_id: string;
  driver_name: string;
  count: number;
  outstanding_pence: number;
}

/** Per-driver outstanding charges to recover. */
export async function driverRecoverySummary(tenantId: string): Promise<DriverRecovery[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('charges')
    .select('driver_id, amount_pence, status')
    .eq('tenant_id', tenantId)
    .in('status', [...OPEN_STATUSES])
    .not('driver_id', 'is', null);
  const rows = (data ?? []) as { driver_id: string; amount_pence: number; status: string }[];
  if (rows.length === 0) return [];

  const byDriver = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const e = byDriver.get(r.driver_id) ?? { count: 0, total: 0 };
    e.count += 1;
    e.total += r.amount_pence;
    byDriver.set(r.driver_id, e);
  }

  const { data: drivers } = await sb.from('drivers').select('id, full_name').in('id', [...byDriver.keys()]);
  const names = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));
  return [...byDriver.entries()]
    .map(([driver_id, e]) => ({
      driver_id,
      driver_name: names.get(driver_id) ?? '—',
      count: e.count,
      outstanding_pence: e.total,
    }))
    .sort((a, b) => b.outstanding_pence - a.outstanding_pence);
}

/** Charges not yet assigned to a driver (e.g. fresh from an authority statement). */
export async function unassignedCharges(tenantId: string): Promise<number> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('charges')
    .select('id')
    .eq('tenant_id', tenantId)
    .is('driver_id', null)
    .in('status', [...OPEN_STATUSES]);
  return (data ?? []).length;
}

/** Totals by charge type (for the reconciliation summary). */
export async function chargesByType(tenantId: string): Promise<{ type: string; count: number; total_pence: number }[]> {
  const sb = createServiceClient();
  const { data } = await sb.from('charges').select('type, amount_pence').eq('tenant_id', tenantId).in('status', [...OPEN_STATUSES]);
  const rows = (data ?? []) as { type: string; amount_pence: number }[];
  const totals = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const e = totals.get(r.type) ?? { count: 0, total: 0 };
    e.count += 1;
    e.total += r.amount_pence;
    totals.set(r.type, e);
  }
  return [...totals.entries()]
    .map(([type, e]) => ({ type, count: e.count, total_pence: e.total }))
    .sort((a, b) => b.total_pence - a.total_pence);
}

/** Assign an unassigned charge to a driver and mark them liable. */
export async function assignChargeToDriver(tenantId: string, chargeId: string, driverId: string, actor: string): Promise<void> {
  const sb = createServiceClient();
  const { data: driver } = await sb.from('drivers').select('id').eq('id', driverId).eq('tenant_id', tenantId).maybeSingle();
  if (!driver) throw new Error('Driver not found in this organisation.');
  const { data: updated, error } = await sb
    .from('charges')
    .update({ driver_id: driverId, status: 'driver_liable' } as never)
    .eq('id', chargeId)
    .eq('tenant_id', tenantId)
    .select('id');
  if (error) throw new Error(`Could not assign charge: ${error.message}`);
  if (!updated || updated.length === 0) throw new Error('Charge not found in this organisation.');
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'charge.assigned',
    p_entity_type: 'charge',
    p_entity_id: chargeId,
    p_detail: { driver_id: driverId } as never,
    p_actor: actor,
  });
}

/** Mark a charge recovered from (or written off against) the driver. */
export async function reconcileCharge(
  tenantId: string,
  chargeId: string,
  status: 'paid_by_driver' | 'paid_by_company' | 'cancelled',
  actor: string,
): Promise<void> {
  const sb = createServiceClient();
  const { data: updated, error } = await sb
    .from('charges')
    .update({ status } as never)
    .eq('id', chargeId)
    .eq('tenant_id', tenantId)
    .select('id');
  if (error) throw new Error(`Could not reconcile charge: ${error.message}`);
  if (!updated || updated.length === 0) throw new Error('Charge not found in this organisation.');
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'charge.reconciled',
    p_entity_type: 'charge',
    p_entity_id: chargeId,
    p_detail: { status } as never,
    p_actor: actor,
  });
}
