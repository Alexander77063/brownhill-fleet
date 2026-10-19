// src/lib/queries-ops-incidents.ts
// Ops-side read of driver_damage_reports — full tenant-wide list with
// vehicle + driver name joins so the /ops/incidents queue can render
// each row as "Driver X on Vehicle Y reported new minor damage" rather
// than just UUIDs.

import { localDb } from '@/lib/auth/local-store';
import type { DamageReportStatus, DamageSeverity } from '@/lib/driver/damage-report-status';

export interface OpsIncidentRow {
  id: string;
  vehicleId: string;
  vehicleReg: string;
  driverName: string;
  severity: DamageSeverity;
  description: string;
  status: DamageReportStatus;
  createdAt: string;
  reviewedAt: string | null;
  resolutionNotes: string | null;
  photoPath: string | null;
}

export async function listOpenIncidents(): Promise<OpsIncidentRow[]> {
  const sql = await localDb();
  // "Open" here means everything not in a terminal state — ops wants to
  // see the queue in one view including the reviewed/in_repair work in
  // progress, not just the unread items.
  const rows = (await sql`
    select r.id, r.vehicle_id, r.severity, r.description, r.status,
           r.created_at, r.reviewed_at, r.resolution_notes, r.photo_path,
           v.registration as vehicle_reg,
           d.full_name as driver_name
      from driver_damage_reports r
      join vehicles v on v.id = r.vehicle_id
      join drivers  d on d.id = r.driver_id
     where r.status in ('open','reviewed','in_repair')
     order by
       case r.severity when 'major' then 0 when 'moderate' then 1 else 2 end,
       r.created_at desc
  `) as Array<{
    id: string; vehicle_id: string; severity: string; description: string;
    status: string; created_at: string; reviewed_at: string | null;
    resolution_notes: string | null; photo_path: string | null;
    vehicle_reg: string; driver_name: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    vehicleId: r.vehicle_id,
    vehicleReg: r.vehicle_reg,
    driverName: r.driver_name,
    severity: r.severity as DamageSeverity,
    description: r.description,
    status: r.status as DamageReportStatus,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    resolutionNotes: r.resolution_notes,
    photoPath: r.photo_path,
  }));
}

export async function listRecentIncidents(limit = 50): Promise<OpsIncidentRow[]> {
  const sql = await localDb();
  const rows = (await sql`
    select r.id, r.vehicle_id, r.severity, r.description, r.status,
           r.created_at, r.reviewed_at, r.resolution_notes, r.photo_path,
           v.registration as vehicle_reg,
           d.full_name as driver_name
      from driver_damage_reports r
      join vehicles v on v.id = r.vehicle_id
      join drivers  d on d.id = r.driver_id
     order by r.created_at desc
     limit ${limit}
  `) as Array<{
    id: string; vehicle_id: string; severity: string; description: string;
    status: string; created_at: string; reviewed_at: string | null;
    resolution_notes: string | null; photo_path: string | null;
    vehicle_reg: string; driver_name: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    vehicleId: r.vehicle_id,
    vehicleReg: r.vehicle_reg,
    driverName: r.driver_name,
    severity: r.severity as DamageSeverity,
    description: r.description,
    status: r.status as DamageReportStatus,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    resolutionNotes: r.resolution_notes,
    photoPath: r.photo_path,
  }));
}

export async function countOpenIncidents(): Promise<number> {
  const sql = await localDb();
  const rows = (await sql`
    select count(*)::int as n
      from driver_damage_reports
     where status in ('open','reviewed','in_repair')
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}