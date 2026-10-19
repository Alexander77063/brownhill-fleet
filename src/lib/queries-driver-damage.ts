// src/lib/queries-driver-damage.ts
// Driver-side read for the driver's own damage reports — used by
// /driver/report to show "Your recent reports" and by the driver home
// to surface open incidents. Lives next to the rest of the driver
// queries (src/lib/queries.ts etc.) rather than under /lib/ops so the
// RLS seam is obvious.

import { createClient } from '@/lib/supabase/server';
import type { DamageReportStatus, DamageSeverity } from '@/lib/driver/damage-report-status';

export interface MyDamageReportRow {
  id: string;
  vehicleId: string;
  severity: DamageSeverity;
  description: string;
  status: DamageReportStatus;
  createdAt: string;
}

export async function getMyDamageReports(driverId: string): Promise<MyDamageReportRow[]> {
  const sb = await createClient();
  const { data, error } = await sb
    .from('driver_damage_reports' as never)
    .select('id, vehicle_id, severity, description, status, created_at')
    .eq('driver_id', driverId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`driver_damage_reports read failed: ${error.message}`);
  return ((data ?? []) as unknown as Array<{
    id: string; vehicle_id: string; severity: string; description: string;
    status: string; created_at: string;
  }>).map((r) => ({
    id: r.id,
    vehicleId: r.vehicle_id,
    severity: r.severity as DamageSeverity,
    description: r.description,
    status: r.status as DamageReportStatus,
    createdAt: r.created_at,
  }));
}