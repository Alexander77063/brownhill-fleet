/**
 * Vehicle immobilisation — the last hop, now real (NG-3 §6).
 *
 * Policy (user decision 2026-09-05): only our on-call team sends an engine cut,
 * against a verified (acknowledged) owner request, and only when the vehicle
 * is stopped or crawling. Tenant ops raise a request; they never send.
 *
 * The seam is still one function — `sendImmobiliseCommand` — but it now checks
 * the vehicle's fitted unit has a relay and is registered with our Traccar
 * gateway, applies the speed gate, and sends `engineStop` / `engineResume`.
 * Every attempt, delivered or refused, is a command row with provenance.
 */
import { deliverAlert, raiseAlert } from '@/lib/alerts/deliver';
import { immobiliseKey } from '@/lib/alerts/dedupe';
import { platformSettings } from '@/lib/collection/settings';
import { hardwareEvent } from '@/lib/hardware/events';
import { type GateResult, gateReasonText, speedGate } from '@/lib/hardware/speed-gate';
import { type Env, type TraccarClient, traccarClient } from '@/lib/hardware/traccar';
import { createServiceClient } from '@/lib/supabase/server';

type Sb = ReturnType<typeof createServiceClient>;

export type ImmobiliseAction = 'immobilise' | 'release';
export type CommandStatus = 'pending' | 'sent' | 'acknowledged' | 'failed';
export type UnavailableReason = 'no-device' | 'no-relay' | 'no-traccar' | 'not-registered';

export interface HardwareAvailability {
  available: boolean;
  reason?: UnavailableReason;
  deviceId?: string;
  unitId?: string;
  imei?: string;
  traccarDeviceId?: number;
}

export const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  'no-device': 'No tracker is fitted to this vehicle.',
  'no-relay': 'The fitted tracker has no immobiliser relay (Platinum hardware needed).',
  'no-traccar': 'The tracking gateway is not configured on this instance.',
  'not-registered': 'The fitted unit is not registered with the tracking gateway yet.',
};

function pick(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Per vehicle: can an engine command physically reach it? */
export async function immobilisationHardwareAvailable(
  tenantId: string,
  vehicleId: string,
  env: Env = process.env,
  sb: Sb = createServiceClient(),
): Promise<HardwareAvailability> {
  const { data } = await sb
    .from('telematics_devices')
    .select('id, unit_id, device_units(id, imei, has_immobiliser, traccar_device_id)')
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId)
    .eq('kind', 'hardware')
    .is('removed_at', null)
    .maybeSingle();
  const unit = pick(data?.device_units) as { id: string; imei: string; has_immobiliser: boolean; traccar_device_id: number | null } | null;
  if (!data || !unit) return { available: false, reason: 'no-device' };
  const base = { deviceId: data.id, unitId: unit.id, imei: unit.imei };
  if (!unit.has_immobiliser) return { available: false, reason: 'no-relay', ...base };
  if (!env.TRACCAR_URL || !env.TRACCAR_TOKEN) return { available: false, reason: 'no-traccar', ...base };
  if (!unit.traccar_device_id) return { available: false, reason: 'not-registered', ...base };
  return { available: true, ...base, traccarDeviceId: unit.traccar_device_id };
}

export interface SendContext {
  traccar?: TraccarClient;
  now?: Date;
  env?: Env;
  sb?: Sb;
}

export interface SendResult {
  delivered: boolean;
  status: CommandStatus;
  /** Why it was not delivered (availability or gate), or 'queued' when Traccar holds it for an offline device. */
  reason?: string;
  /** Human wording for the reason, for the console. */
  reasonText?: string;
  speedKph: number | null;
  externalRef: string | null;
  deviceId: string | null;
  unitId: string | null;
}

/**
 * The hardware seam: availability → speed gate → Traccar command. Never throws;
 * a refusal or a gateway error comes back as `delivered: false` with a reason
 * so the caller records it.
 */
export async function sendImmobiliseCommand(tenantId: string, vehicleId: string, action: ImmobiliseAction, ctx: SendContext = {}): Promise<SendResult> {
  const sb = ctx.sb ?? createServiceClient();
  const env = ctx.env ?? process.env;
  const avail = await immobilisationHardwareAvailable(tenantId, vehicleId, env, sb);
  const ids = { deviceId: avail.deviceId ?? null, unitId: avail.unitId ?? null };
  if (!avail.available || !avail.traccarDeviceId) {
    const reason = avail.reason ?? 'no-device';
    return { delivered: false, status: 'failed', reason, reasonText: UNAVAILABLE_TEXT[reason], speedKph: null, externalRef: null, ...ids };
  }
  const settings = await platformSettings(sb);
  const { data: pos } = await sb.from('vehicle_positions').select('speed_mph, recorded_at').eq('vehicle_id', vehicleId).maybeSingle();
  const gate: GateResult = speedGate(
    pos ? { speedMph: pos.speed_mph == null ? null : Number(pos.speed_mph), recordedAt: pos.recorded_at } : null,
    ctx.now ?? new Date(),
    settings,
    action,
  );
  if (!gate.ok) {
    return { delivered: false, status: 'failed', reason: gate.reason, reasonText: gateReasonText(gate.reason, settings), speedKph: gate.speedKph, externalRef: null, ...ids };
  }
  const traccar = ctx.traccar ?? traccarClient(env);
  try {
    const r = await traccar.sendCommand(avail.traccarDeviceId, action === 'immobilise' ? 'engineStop' : 'engineResume');
    if (r.status === 'queued') {
      return { delivered: true, status: 'pending', reason: 'queued', reasonText: 'The tracker is offline; the gateway will deliver the command when it reconnects.', speedKph: gate.speedKph, externalRef: r.externalRef, ...ids };
    }
    return { delivered: true, status: 'sent', speedKph: gate.speedKph, externalRef: r.externalRef, ...ids };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'gateway error';
    return { delivered: false, status: 'failed', reason: 'gateway', reasonText: `The tracking gateway refused the command: ${msg}`, speedKph: gate.speedKph, externalRef: null, ...ids };
  }
}

export interface ImmobilisationState {
  /** The most recent action requested for the vehicle, or null if none yet. */
  requested: ImmobiliseAction | null;
  status: CommandStatus | null;
  at: string | null;
  /** Whether a real device can actually enforce it. */
  hardwareConnected: boolean;
  /** Why not, when it cannot. */
  unavailableReason: UnavailableReason | null;
}

/** Latest immobilisation state for a vehicle (derived from the command log). */
export async function getImmobilisationState(tenantId: string, vehicleId: string, env: Env = process.env): Promise<ImmobilisationState> {
  const sb = createServiceClient();
  const [{ data }, avail] = await Promise.all([
    sb.from('immobilisation_commands').select('action, status, created_at').eq('tenant_id', tenantId).eq('vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    immobilisationHardwareAvailable(tenantId, vehicleId, env, sb),
  ]);
  return {
    requested: (data?.action as ImmobiliseAction) ?? null,
    status: (data?.status as CommandStatus) ?? null,
    at: data?.created_at ?? null,
    hardwareConnected: avail.available,
    unavailableReason: avail.available ? null : (avail.reason ?? null),
  };
}

export interface RequestContext extends SendContext {
  /** The owner request this command answers (the platform path always has one). */
  requestId?: string | null;
  /** The on-call user who pressed the button. */
  executedBy?: string | null;
}

export interface CommandOutcome {
  commandId: string | null;
  status: CommandStatus;
  delivered: boolean;
  reason?: string;
  reasonText?: string;
  speedKph: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record + attempt an immobilise/release command. The caller has already
 * checked policy (entitlement, permission, and — on the platform path — that
 * the request is acknowledged). Writes the command row with provenance whether
 * or not it was delivered, tells the owner only when it actually went out, and
 * audits it.
 */
export async function requestImmobilisation(
  tenantId: string,
  vehicleId: string,
  action: ImmobiliseAction,
  issuedBy: string | null,
  ctx: RequestContext = {},
): Promise<CommandOutcome> {
  const sb = ctx.sb ?? createServiceClient();
  const result = await sendImmobiliseCommand(tenantId, vehicleId, action, ctx);
  const now = (ctx.now ?? new Date()).toISOString();
  const actor = ctx.executedBy ?? issuedBy ?? 'system';

  const { data: cmd, error } = await sb
    .from('immobilisation_commands')
    .insert({
      tenant_id: tenantId,
      vehicle_id: vehicleId,
      action,
      status: result.status,
      issued_by: issuedBy && UUID.test(issuedBy) ? issuedBy : null,
      executed_by: ctx.executedBy && UUID.test(ctx.executedBy) ? ctx.executedBy : null,
      request_id: ctx.requestId ?? null,
      device_id: result.deviceId,
      unit_id: result.unitId,
      speed_kph_at_send: result.speedKph,
      sent_at: result.delivered ? now : null,
      external_ref: result.externalRef,
      failure_reason: result.delivered ? null : (result.reasonText ?? result.reason ?? null),
      detail: { reason: result.reason ?? null, delivered: result.delivered } as never,
    } as never)
    .select('id')
    .maybeSingle();
  if (error) console.error('[immobilise] command row failed', vehicleId, error.message);

  if (result.deviceId || result.unitId) {
    await hardwareEvent(sb, {
      tenantId,
      deviceId: result.deviceId,
      unitId: result.unitId,
      kind: `command_${action}`,
      actor,
      detail: { status: result.status, delivered: result.delivered, reason: result.reason ?? null, speedKph: result.speedKph, requestId: ctx.requestId ?? null, commandId: cmd?.id ?? null },
    }).catch((e: unknown) => console.error('[immobilise] event failed', e));
  }

  // Tell the owner only when the command really went out — never announce a cut that did not happen.
  if (result.status === 'sent' && cmd?.id) {
    try {
      const { data: veh } = await sb.from('vehicles').select('owner_id').eq('id', vehicleId).maybeSingle();
      if (veh?.owner_id) {
        const { id, inserted } = await raiseAlert(sb, {
          tenantId,
          vehicleId,
          ownerId: veh.owner_id,
          kind: action === 'immobilise' ? 'immobilised' : 'released',
          severity: 'info',
          occurredAt: now,
          lat: null,
          lng: null,
          speedKph: result.speedKph,
          detail: { status: result.status, delivered: result.delivered, requestId: ctx.requestId ?? null },
          dedupeKey: immobiliseKey(cmd.id),
        });
        if (inserted && id) await deliverAlert(sb, id);
      }
    } catch (e) {
      console.error('[immobilise] owner alert failed', vehicleId, e);
    }
  }

  const { error: auditErr } = await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: `vehicle.${action}`,
    p_entity_type: 'vehicle',
    p_entity_id: vehicleId,
    p_detail: { status: result.status, delivered: result.delivered, reason: result.reason ?? null, speedKph: result.speedKph, requestId: ctx.requestId ?? null, commandId: cmd?.id ?? null } as never,
    ...(ctx.executedBy && UUID.test(ctx.executedBy) ? { p_actor: ctx.executedBy } : {}),
  } as never);
  if (auditErr) console.error('[immobilise] audit failed', vehicleId, auditErr.message);

  return { commandId: cmd?.id ?? null, status: result.status, delivered: result.delivered, reason: result.reason, reasonText: result.reasonText, speedKph: result.speedKph };
}
