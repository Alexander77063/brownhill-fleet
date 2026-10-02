/**
 * Board reports — a director/investor KPI pack assembled tenant-scoped from base
 * data plus the finance/compliance helpers. Gated in the UI by reports.board;
 * printable to a PDF board pack.
 */

import { createServiceClient } from '@/lib/supabase/server';
import { getBlockedEntities } from '@/lib/compliance';
import { expenseSummaryByCategory } from '@/lib/expenses';
import { driverRecoverySummary } from '@/lib/reconciliation';

export interface BoardReport {
  fleet: { vehicles: number; on_hire: number; off_road: number; utilisation_pct: number };
  operations: { active_drivers: number; active_agreements: number };
  finance: { received_pence: number; expenses_pence: number; net_pence: number };
  risk: {
    open_obligations: number;
    blocked_vehicles: number;
    blocked_drivers: number;
    charges_to_recover_pence: number;
  };
  expenses_by_category: { category: string; total_pence: number }[];
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export async function assembleBoardReport(tenantId: string): Promise<BoardReport> {
  const sb = createServiceClient();

  const [vehicles, drivers, agreements, payments, obligations, blocked, expensesByCat, recovery] = await Promise.all([
    sb.from('vehicles').select('status').eq('tenant_id', tenantId),
    sb.from('drivers').select('status').eq('tenant_id', tenantId),
    sb.from('agreements').select('status').eq('tenant_id', tenantId),
    sb.from('payments').select('amount_pence, status').eq('tenant_id', tenantId).eq('status', 'confirmed'),
    sb.from('obligations').select('id').eq('tenant_id', tenantId).in('status', ['due_soon', 'overdue']),
    getBlockedEntities(tenantId),
    expenseSummaryByCategory(tenantId),
    driverRecoverySummary(tenantId),
  ]);

  const vRows = (vehicles.data ?? []) as { status: string }[];
  const onHire = vRows.filter((v) => v.status === 'on_hire').length;
  const offRoad = vRows.filter((v) => v.status === 'off_road').length;
  const activeDrivers = ((drivers.data ?? []) as { status: string }[]).filter((d) => d.status === 'active').length;
  const activeAgreements = ((agreements.data ?? []) as { status: string }[]).filter((a) => a.status === 'active').length;
  const received = ((payments.data ?? []) as { amount_pence: number }[]).reduce((s, p) => s + p.amount_pence, 0);
  const expenses = expensesByCat.reduce((s, c) => s + c.total_pence, 0);
  const toRecover = recovery.reduce((s, r) => s + r.outstanding_pence, 0);

  return {
    fleet: {
      vehicles: vRows.length,
      on_hire: onHire,
      off_road: offRoad,
      utilisation_pct: pct(onHire, vRows.length),
    },
    operations: { active_drivers: activeDrivers, active_agreements: activeAgreements },
    finance: { received_pence: received, expenses_pence: expenses, net_pence: received - expenses },
    risk: {
      open_obligations: (obligations.data ?? []).length,
      blocked_vehicles: blocked.vehicles,
      blocked_drivers: blocked.drivers,
      charges_to_recover_pence: toRecover,
    },
    expenses_by_category: expensesByCat,
  };
}
