/**
 * The platform side of an engine command: the on-call executes it against an
 * acknowledged owner request, and Traccar's command result closes the loop.
 */
import { type CommandStatus, type ImmobiliseAction, requestImmobilisation, type CommandOutcome } from '@/lib/immobilise';
import { getRequest } from '@/lib/requests';
import { createServiceClient } from '@/lib/supabase/server';
import { hardwareEvent } from './events';
import type { Env, TraccarClient } from './traccar';

type Sb = ReturnType<typeof createServiceClient>;

export const COMMANDABLE_REQUEST_KINDS = ['stolen', 'immobilise'] as const;

export interface ExecuteArgs {
  requestId: string;
  action: ImmobiliseAction;
  /** The platform user pressing the button (audited, stored on the command). */
  executedBy: string;
  sb?: Sb;
  traccar?: TraccarClient;
  now?: Date;
  env?: Env;
}

/**
 * Send an engine command for a request. Refuses unless the request is
 * acknowledged (someone has it and has verified it with the owner), still
 * open, of a kind that warrants it, and names a vehicle. The speed gate and
 * hardware checks run inside `requestImmobilisation`.
 */
export async function executeImmobilise(a: ExecuteArgs): Promise<CommandOutcome & { tenantId: string; vehicleId: string }> {
  const sb = a.sb ?? createServiceClient();
  const r = await getRequest(a.requestId, sb);
  if (!r) throw new Error('Request not found.');
  if (r.status === 'closed') throw new Error('This request is closed. Reopen it or raise a new one.');
  if (r.status !== 'acknowledged') throw new Error('Acknowledge the request first: verify it with the owner, then execute.');
  if (!(COMMANDABLE_REQUEST_KINDS as readonly string[]).includes(r.kind)) throw new Error(`An engine command needs a stolen-vehicle or immobilise request, not "${r.kind}".`);
  if (!r.vehicle) throw new Error('This request names no vehicle.');
  const outcome = await requestImmobilisation(r.tenantId, r.vehicle.id, a.action, a.executedBy, {
    requestId: r.id,
    executedBy: a.executedBy,
    sb,
    traccar: a.traccar,
    now: a.now,
    env: a.env,
  });
  const { error: auditErr } = await sb.rpc('log_audit', {
    p_tenant: r.tenantId,
    p_action: `owner_request.${a.action}`,
    p_entity_type: 'owner_request',
    p_entity_id: r.id,
    p_detail: { status: outcome.status, delivered: outcome.delivered, reason: outcome.reason ?? null, speedKph: outcome.speedKph, commandId: outcome.commandId } as never,
    p_actor: a.executedBy,
  } as never);
  if (auditErr) console.error('[immobilise] audit failed', r.id, auditErr.message);
  return { ...outcome, tenantId: r.tenantId, vehicleId: r.vehicle.id };
}

const FAILED_RESULT = /fail|error|unsupported|not supported|invalid|timeout/i;

/**
 * Traccar reports what the device answered. The newest in-flight command for
 * that unit becomes acknowledged or failed. Unknown units and idle devices are
 * ignored, never errors.
 */
export async function handleCommandResult(
  imei: string,
  result: string | null,
  commandType: string | null,
  sb: Sb = createServiceClient(),
): Promise<'acknowledged' | 'failed' | 'ignored'> {
  const { data: unit } = await sb.from('device_units').select('id, tenant_id').eq('imei', imei).maybeSingle();
  if (!unit) return 'ignored';
  const { data: cmd } = await sb
    .from('immobilisation_commands')
    .select('id, tenant_id, vehicle_id, device_id, action')
    .eq('unit_id', unit.id)
    .in('status', ['sent', 'pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!cmd) return 'ignored';
  const failed = result != null && FAILED_RESULT.test(result);
  const status: CommandStatus = failed ? 'failed' : 'acknowledged';
  await sb
    .from('immobilisation_commands')
    .update(failed ? { status, failure_reason: `Device answered: ${result}` } : ({ status, acked_at: new Date().toISOString() } as never))
    .eq('id', cmd.id);
  await hardwareEvent(sb, {
    tenantId: cmd.tenant_id,
    unitId: unit.id,
    deviceId: cmd.device_id,
    kind: failed ? 'command_failed' : 'command_acknowledged',
    actor: 'traccar',
    detail: { commandId: cmd.id, action: cmd.action, commandType, result },
  });
  return status;
}

export interface CommandRow {
  id: string;
  action: ImmobiliseAction;
  status: CommandStatus;
  createdAt: string;
  sentAt: string | null;
  ackedAt: string | null;
  speedKphAtSend: number | null;
  failureReason: string | null;
  requestId: string | null;
  executedBy: string | null;
}

/** The command log for a vehicle, newest first. */
export async function commandsForVehicle(tenantId: string, vehicleId: string, limit = 20, sb: Sb = createServiceClient()): Promise<CommandRow[]> {
  const { data } = await sb
    .from('immobilisation_commands')
    .select('id, action, status, created_at, sent_at, acked_at, speed_kph_at_send, failure_reason, request_id, executed_by')
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    id: r.id,
    action: r.action as ImmobiliseAction,
    status: r.status as CommandStatus,
    createdAt: r.created_at,
    sentAt: r.sent_at ?? null,
    ackedAt: r.acked_at ?? null,
    speedKphAtSend: r.speed_kph_at_send == null ? null : Number(r.speed_kph_at_send),
    failureReason: r.failure_reason ?? null,
    requestId: r.request_id ?? null,
    executedBy: r.executed_by ?? null,
  }));
}

/** Commands raised against a request, newest first (the assistance page). */
export async function commandsForRequest(requestId: string, sb: Sb = createServiceClient()): Promise<CommandRow[]> {
  const { data } = await sb
    .from('immobilisation_commands')
    .select('id, action, status, created_at, sent_at, acked_at, speed_kph_at_send, failure_reason, request_id, executed_by')
    .eq('request_id', requestId)
    .order('created_at', { ascending: false });
  return (data ?? []).map((r) => ({
    id: r.id,
    action: r.action as ImmobiliseAction,
    status: r.status as CommandStatus,
    createdAt: r.created_at,
    sentAt: r.sent_at ?? null,
    ackedAt: r.acked_at ?? null,
    speedKphAtSend: r.speed_kph_at_send == null ? null : Number(r.speed_kph_at_send),
    failureReason: r.failure_reason ?? null,
    requestId: r.request_id ?? null,
    executedBy: r.executed_by ?? null,
  }));
}
