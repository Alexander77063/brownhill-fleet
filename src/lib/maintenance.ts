/**
 * Maintenance scheduler — a forward-looking service schedule per vehicle.
 * Completing a service logs a maintenance_record and rolls the next-due date
 * forward by the interval. Due/overdue services feed the obligations surface
 * (service_due) so they appear in the compliance cockpit + reminders.
 */

import { createServiceClient } from '@/lib/supabase/server';
import { gradeObligation, ragOf, type Rag } from '@/lib/compliance';

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ScheduleRow {
  id: string;
  vehicle_id: string;
  registration: string | null;
  kind: string;
  interval_days: number;
  last_done_on: string | null;
  next_due_on: string;
  rag: Rag;
}

export async function listSchedules(tenantId: string, today: string): Promise<ScheduleRow[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('maintenance_schedules')
    .select('id, vehicle_id, kind, interval_days, last_done_on, next_due_on')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('next_due_on');
  const rows = (data ?? []) as Omit<ScheduleRow, 'registration' | 'rag'>[];
  if (rows.length === 0) return [];
  const { data: vehicles } = await sb.from('vehicles').select('id, registration').in('id', rows.map((r) => r.vehicle_id));
  const regs = new Map((vehicles ?? []).map((v) => [v.id, v.registration]));
  return rows.map((r) => {
    const g = gradeObligation(today, r.next_due_on);
    return { ...r, registration: regs.get(r.vehicle_id) ?? null, rag: ragOf(g.status, g.severity) };
  });
}

/** Create or update a vehicle's schedule for a kind of work. */
export async function upsertSchedule(
  tenantId: string,
  vehicleId: string,
  kind: string,
  intervalDays: number,
  nextDueOn: string,
  actor: string,
): Promise<void> {
  const sb = createServiceClient();
  const { data: veh } = await sb.from('vehicles').select('id').eq('id', vehicleId).eq('tenant_id', tenantId).maybeSingle();
  if (!veh) throw new Error('Vehicle not found in this organisation.');
  const { error } = await sb
    .from('maintenance_schedules')
    .upsert({ tenant_id: tenantId, vehicle_id: vehicleId, kind, interval_days: intervalDays, next_due_on: nextDueOn } as never, {
      onConflict: 'tenant_id,vehicle_id,kind',
    });
  if (error) throw new Error(`Could not save schedule: ${error.message}`);
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'maintenance.scheduled',
    p_entity_type: 'vehicle',
    p_entity_id: vehicleId,
    p_detail: { kind, next_due_on: nextDueOn } as never,
    p_actor: actor,
  });
}

export interface CompleteServiceInput {
  doneOn: string;
  costPence: number;
  payer: 'company' | 'driver';
  odometerMiles?: number | null;
  note?: string;
}

/** Log a completed service and roll the schedule forward by its interval. */
export async function completeService(tenantId: string, scheduleId: string, input: CompleteServiceInput, actor: string): Promise<{ nextDueOn: string }> {
  const sb = createServiceClient();
  const { data: sched } = await sb
    .from('maintenance_schedules')
    .select('id, vehicle_id, kind, interval_days')
    .eq('id', scheduleId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!sched) throw new Error('Schedule not found in this organisation.');

  const { error: recErr } = await sb.from('maintenance_records').insert({
    tenant_id: tenantId,
    vehicle_id: sched.vehicle_id,
    payer: input.payer,
    description: input.note?.trim() || `${sched.kind} service`,
    cost_pence: Math.max(0, Math.round(input.costPence)),
    service_on: input.doneOn,
    odometer_miles: input.odometerMiles ?? null,
  } as never);
  if (recErr) throw new Error(`Could not log service: ${recErr.message}`);

  const nextDueOn = addDays(input.doneOn, sched.interval_days);
  const { error: schErr } = await sb
    .from('maintenance_schedules')
    .update({ last_done_on: input.doneOn, next_due_on: nextDueOn } as never)
    .eq('id', scheduleId);
  if (schErr) throw new Error(`Could not update schedule: ${schErr.message}`);

  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'maintenance.completed',
    p_entity_type: 'vehicle',
    p_entity_id: sched.vehicle_id,
    p_detail: { kind: sched.kind, done_on: input.doneOn, next_due_on: nextDueOn } as never,
    p_actor: actor,
  });
  return { nextDueOn };
}

/** Raise service_due obligations for schedules due within 30 days. Returns count. */
export async function syncServiceObligations(today: string): Promise<number> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('maintenance_schedules')
    .select('tenant_id, vehicle_id, kind, next_due_on')
    .eq('is_active', true);
  const rows = ((data ?? []) as { tenant_id: string; vehicle_id: string; kind: string; next_due_on: string }[]).filter(
    (s) => new Date(`${s.next_due_on}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime() <= 30 * 86_400_000,
  );
  if (rows.length === 0) return 0;
  const obligations = rows.map((s) => ({
    tenant_id: s.tenant_id,
    entity_type: 'vehicle',
    entity_id: s.vehicle_id,
    type: 'service_due',
    title: `${s.kind ? s.kind[0].toUpperCase() + s.kind.slice(1) : 'Service'} due ${s.next_due_on}`,
    due_date: s.next_due_on,
    ...gradeObligation(today, s.next_due_on),
  }));
  const { error } = await sb.from('obligations').upsert(obligations as never, { onConflict: 'entity_type,entity_id,type' });
  if (error) throw new Error(`service obligations upsert: ${error.message}`);
  return obligations.length;
}
