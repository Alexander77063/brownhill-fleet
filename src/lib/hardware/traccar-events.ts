/**
 * What we do with Traccar's event forwarding: a device's answer to a command
 * closes the command; a device-health alarm opens a fault job on the fitted
 * vehicle; online/offline are noted on the unit's timeline (once per change,
 * not once per reconnect). Unknown IMEIs are ignored, never errors.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { handleCommandResult } from './commands';
import { hardwareEvent } from './events';
import { createFaultJob } from './jobs';
import { ACTIONABLE_ALARMS, type TraccarEvent } from './traccar';

type Sb = ReturnType<typeof createServiceClient>;

export type EventOutcome = 'acknowledged' | 'failed' | 'fault_job' | 'noted' | 'ignored';

export async function handleTraccarEvent(ev: TraccarEvent, sb: Sb = createServiceClient()): Promise<EventOutcome> {
  if (ev.kind === 'ignored') return 'ignored';
  if (ev.kind === 'commandResult') return handleCommandResult(ev.imei, ev.result, ev.commandType, sb);

  const { data: unit } = await sb.from('device_units').select('id, tenant_id, vehicle_id, state').eq('imei', ev.imei).maybeSingle();
  if (!unit) return 'ignored';

  if (ev.kind !== 'alarm') {
    const kind = ev.kind === 'deviceOnline' ? 'online' : 'offline';
    if (kind === 'online') await sb.from('device_units').update({ last_seen_at: new Date().toISOString() } as never).eq('id', unit.id);
    const { data: last } = await sb.from('hardware_events').select('kind').eq('unit_id', unit.id).in('kind', ['online', 'offline']).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (last?.kind !== kind) await hardwareEvent(sb, { tenantId: unit.tenant_id, unitId: unit.id, kind, actor: 'traccar' });
    return 'noted';
  }

  const alarm = ev.alarm;
  await hardwareEvent(sb, { tenantId: unit.tenant_id, unitId: unit.id, kind: 'alarm', actor: 'traccar', detail: { alarm } });
  if (!ACTIONABLE_ALARMS.has(alarm) || !unit.tenant_id || !unit.vehicle_id || unit.state !== 'fitted') return 'noted';
  try {
    const r = await createFaultJob(unit.tenant_id, unit.vehicle_id, 'alarm', { alarm }, { actor: 'traccar', sb });
    return r.created ? 'fault_job' : 'noted';
  } catch (e) {
    console.error('[traccar] fault job failed', ev.imei, e);
    return 'noted';
  }
}
