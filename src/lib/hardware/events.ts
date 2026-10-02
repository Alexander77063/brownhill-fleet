/**
 * The hardware timeline: what happened to a job, a unit, or a device, by whom.
 * Append-only; read by the console's job and stock pages.
 */
import { createServiceClient } from '@/lib/supabase/server';

type Sb = ReturnType<typeof createServiceClient>;

export interface HardwareEventInput {
  tenantId?: string | null;
  jobId?: string | null;
  unitId?: string | null;
  deviceId?: string | null;
  kind: string;
  actor: string;
  detail?: Record<string, unknown>;
}

export interface HardwareEventRow {
  id: string;
  tenantId: string | null;
  jobId: string | null;
  unitId: string | null;
  deviceId: string | null;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export async function hardwareEvent(sb: Sb, e: HardwareEventInput): Promise<void> {
  const { error } = await sb.from('hardware_events').insert({
    tenant_id: e.tenantId ?? null,
    job_id: e.jobId ?? null,
    unit_id: e.unitId ?? null,
    device_id: e.deviceId ?? null,
    kind: e.kind,
    actor: e.actor,
    detail: (e.detail ?? {}) as never,
  } as never);
  if (error) throw new Error(`hardware event: ${error.message}`);
}

function toRow(r: Record<string, unknown>): HardwareEventRow {
  return {
    id: r.id as string,
    tenantId: (r.tenant_id as string | null) ?? null,
    jobId: (r.job_id as string | null) ?? null,
    unitId: (r.unit_id as string | null) ?? null,
    deviceId: (r.device_id as string | null) ?? null,
    kind: r.kind as string,
    actor: r.actor as string,
    detail: (r.detail as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  };
}

export async function timelineForJob(jobId: string, sb: Sb = createServiceClient()): Promise<HardwareEventRow[]> {
  const { data } = await sb.from('hardware_events').select('*').eq('job_id', jobId).order('created_at');
  return ((data ?? []) as Record<string, unknown>[]).map(toRow);
}

export async function timelineForUnit(unitId: string, sb: Sb = createServiceClient()): Promise<HardwareEventRow[]> {
  const { data } = await sb.from('hardware_events').select('*').eq('unit_id', unitId).order('created_at');
  return ((data ?? []) as Record<string, unknown>[]).map(toRow);
}
