/**
 * How an emergency reaches a person at our end.
 *
 * A stolen-vehicle or immobilise request is not an email. The ladder: push to
 * every on-duty admin, SMS to the on-call roster and a voice call to the
 * priority-1 phone at once; then every five minutes, repeated to the next
 * on-call in turn; after thirty minutes unacknowledged, URGENT to everyone.
 * Acknowledging stops it. Email is written once, as the paper trail.
 *
 * `nextStep` is pure and unit-tested. `runEscalations` drives it from a store
 * and a set of channels that are both injected, so the whole ladder is tested
 * without a database, a phone network, or a push service.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { logNotification } from '@/lib/comms';
import { relativeTime } from '@/lib/display';

export const EMERGENCY_KINDS = ['stolen', 'immobilise'] as const;
export const ROUND_MINUTES = 5;
export const URGENT_AFTER_MINUTES = 30;
/**
 * After three hours the ladder stops ringing phones. The request stays open
 * and red on the console; a phone that has not answered in 36 rounds is not
 * going to, and the roster must not be woken all night by one request.
 */
export const MAX_LADDER_MINUTES = 180;

export type EmergencyKind = (typeof EMERGENCY_KINDS)[number];

export function isEmergencyKind(kind: string): kind is EmergencyKind {
  return (EMERGENCY_KINDS as readonly string[]).includes(kind);
}

export interface OnCall {
  phone: string;
  priority: number;
  name?: string;
}

export interface EscalationRequest {
  id: string;
  kind: string;
  status: string;
  escalation_round: number;
  created_at: string;
  next_escalation_at: string | null;
}

export interface EscalationStep {
  round: number;
  pushAllAdmins: boolean;
  smsTo: string[];
  callTo: string | null;
  urgent: boolean;
  misconfigured: boolean;
  nextAt: Date;
}

/** The next action for one request, or null when none is due. */
export function nextStep(request: EscalationRequest, oncall: OnCall[], now: Date): EscalationStep | null {
  if (request.status !== 'open' || !isEmergencyKind(request.kind)) return null;
  const roster = [...oncall].sort((a, b) => a.priority - b.priority);
  const round = request.escalation_round;
  const ageMin = (now.getTime() - Date.parse(request.created_at)) / 60_000;
  if (ageMin >= MAX_LADDER_MINUTES) return null;
  const urgent = ageMin >= URGENT_AFTER_MINUTES;
  const callTo = roster.length ? roster[round % roster.length].phone : null;
  // Round 0 and every urgent round text the whole roster; the rounds between
  // text the person being called, so one phone is not buzzing for everyone.
  const smsTo = round === 0 || urgent ? roster.map((o) => o.phone) : callTo ? [callTo] : [];
  return {
    round,
    pushAllAdmins: true,
    smsTo,
    callTo,
    urgent,
    misconfigured: roster.length === 0,
    nextAt: new Date(now.getTime() + ROUND_MINUTES * 60_000),
  };
}

export interface EscalationContext {
  tenantId: string;
  ownerName: string;
  ownerPhone: string | null;
  registration: string;
  make: string;
  kind: string;
  note: string | null;
  lastSeenAt: string | null;
  lat: number | null;
  lng: number | null;
}

/** What every channel says. Under 160 characters for the SMS; the voice call reads it twice. */
export function escalationText(
  step: EscalationStep,
  ctx: EscalationContext,
  ackUrl: string | null,
  now: Date = new Date(),
): string {
  // Plain ASCII: an em dash pushes the whole SMS into UCS-2 and quadruples the segments.
  const what = ctx.kind === 'stolen' ? 'reports their vehicle STOLEN' : 'asks for IMMOBILISATION';
  const where = ctx.lat != null && ctx.lng != null ? ` near ${ctx.lat.toFixed(3)},${ctx.lng.toFixed(3)}` : '';
  const when = ctx.lastSeenAt ? `, last seen ${relativeTime(ctx.lastSeenAt, now.getTime())}` : '';
  const head = step.urgent ? 'URGENT, unacknowledged: ' : '';
  const body = `${head}${ctx.ownerName} ${what} - ${ctx.make} ${ctx.registration}${where}${when}.`;
  const tail = ackUrl ? ` Acknowledge: ${ackUrl}` : '';
  return `${body}${tail}`.replace(/\s+/g, ' ').trim();
}

/** What the voice call says: no URL, no coordinates — a person can act on it. */
export function escalationVoiceText(step: EscalationStep, ctx: EscalationContext, now: Date = new Date()): string {
  const what = ctx.kind === 'stolen' ? 'reports their vehicle stolen' : 'asks for their vehicle to be immobilised';
  const when = ctx.lastSeenAt ? `, last seen ${relativeTime(ctx.lastSeenAt, now.getTime())}` : '';
  const head = step.urgent ? 'Urgent, still unacknowledged. ' : '';
  return `${head}Vehicle emergency. ${ctx.ownerName} ${what}: ${ctx.make} ${ctx.registration}${when}. Open the assistance console to acknowledge.`
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ChannelResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

export interface EscalationChannels {
  pushAdmins(payload: { title: string; body: string; url: string; tag?: string }): Promise<{ sent: number }>;
  sms(to: string, text: string): Promise<ChannelResult>;
  call(to: string, text: string): Promise<ChannelResult>;
  email(subject: string, html: string): Promise<ChannelResult>;
}

export interface EscalationStore {
  openEmergencies(now: Date): Promise<EscalationRequest[]>;
  roster(): Promise<OnCall[]>;
  context(requestId: string): Promise<EscalationContext | null>;
  advance(requestId: string, round: number, nextAt: Date): Promise<void>;
  logSms(tenantId: string, requestId: string, round: number, to: string, text: string, r: ChannelResult): Promise<void>;
  audit(tenantId: string, requestId: string, detail: Record<string, unknown>): Promise<void>;
}

export async function runEscalations(
  store: EscalationStore,
  channels: EscalationChannels,
  now: Date,
  opts: { appUrl?: string | null; oncall?: OnCall[] } = {},
): Promise<{ processed: number; steps: number }> {
  const due = await store.openEmergencies(now);
  if (due.length === 0) return { processed: 0, steps: 0 };
  const roster = opts.oncall ?? (await store.roster());
  let steps = 0;

  for (const req of due) {
    const step = nextStep(req, roster, now);
    if (!step) continue;
    const ctx = await store.context(req.id);
    if (!ctx) continue;
    const base = (opts.appUrl ?? '').replace(/\/$/, '');
    const ackUrl = base ? `${base}/platform/assistance/${req.id}/ack` : null;
    const text = escalationText(step, ctx, ackUrl, now);
    const voice = escalationVoiceText(step, ctx, now);
    const outcome: Record<string, unknown> = { round: step.round, urgent: step.urgent, misconfigured: step.misconfigured };

    // Each channel is independent: one failing must not silence the others.
    try {
      const p = await channels.pushAdmins({
        title: step.urgent ? 'URGENT: vehicle emergency' : 'Vehicle emergency',
        body: text,
        url: `/platform/assistance/${req.id}`,
        tag: `request:${req.id}`,
      });
      outcome.push = p.sent;
    } catch (e) {
      outcome.push = `failed: ${e instanceof Error ? e.message : 'error'}`;
    }
    for (const to of step.smsTo) {
      try {
        const r = await channels.sms(to, text);
        await store.logSms(ctx.tenantId, req.id, step.round, to, text, r);
      } catch (e) {
        console.error('[escalation] sms failed', req.id, to, e);
      }
    }
    if (step.callTo) {
      try {
        outcome.call = await channels.call(step.callTo, voice);
      } catch (e) {
        outcome.call = `failed: ${e instanceof Error ? e.message : 'error'}`;
      }
    }
    if (step.round === 0) {
      try {
        outcome.email = await channels.email(
          `Vehicle emergency: ${ctx.registration}`,
          `<p>${escapeHtml(text)}</p><p>Raised ${new Date(req.created_at).toISOString()}.</p>`,
        );
      } catch (e) {
        outcome.email = `failed: ${e instanceof Error ? e.message : 'error'}`;
      }
    }

    await store.audit(ctx.tenantId, req.id, outcome);
    await store.advance(req.id, step.round + 1, step.nextAt);
    steps += 1;
  }
  return { processed: due.length, steps };
}

// ── The real store ────────────────────────────────────────────────────────────

type Sb = ReturnType<typeof createServiceClient>;

export function pgEscalationStore(sb: Sb = createServiceClient()): EscalationStore {
  return {
    // Every method THROWS on a database error. A swallowed error here would
    // make the cron report "nothing due" while an emergency sits unnotified.
    async openEmergencies(now) {
      const { data, error } = await sb
        .from('owner_requests')
        .select('id, kind, status, escalation_round, created_at, next_escalation_at')
        .eq('status', 'open')
        .in('kind', [...EMERGENCY_KINDS])
        .or(`next_escalation_at.is.null,next_escalation_at.lte.${now.toISOString()}`)
        // Never-notified rows first, then the longest overdue.
        .order('next_escalation_at', { ascending: true, nullsFirst: true });
      if (error) throw new Error(`openEmergencies: ${error.message}`);
      return (data ?? []) as EscalationRequest[];
    },
    async roster() {
      const { data, error } = await sb.from('platform_oncall').select('phone, priority, name').eq('active', true).order('priority');
      if (error) throw new Error(`roster: ${error.message}`);
      return (data ?? []) as OnCall[];
    },
    async context(requestId) {
      const { data: r, error } = await sb
        .from('owner_requests')
        .select('tenant_id, kind, note, vehicle_id, owner_id, vehicle_owners(name, phone), vehicles(registration, make)')
        .eq('id', requestId)
        .maybeSingle();
      if (error) throw new Error(`context: ${error.message}`);
      if (!r) return null;
      const owner = pick(r.vehicle_owners) as { name: string; phone: string } | null;
      const vehicle = pick(r.vehicles) as { registration: string; make: string } | null;
      let lastSeenAt: string | null = null;
      let lat: number | null = null;
      let lng: number | null = null;
      if (r.vehicle_id) {
        const { data: pos } = await sb.from('vehicle_positions').select('lat, lng, recorded_at').eq('vehicle_id', r.vehicle_id).maybeSingle();
        lastSeenAt = pos?.recorded_at ?? null;
        lat = pos?.lat ?? null;
        lng = pos?.lng ?? null;
      }
      return {
        tenantId: r.tenant_id,
        ownerName: owner?.name ?? 'An owner',
        ownerPhone: owner?.phone ?? null,
        registration: vehicle?.registration ?? '',
        make: vehicle?.make ?? '',
        kind: r.kind,
        note: r.note,
        lastSeenAt,
        lat,
        lng,
      };
    },
    async advance(requestId, round, nextAt) {
      // `.eq('status','open')`: an acknowledgement that landed while this step
      // was sending must win — it cleared next_escalation_at, and we must not
      // put it back.
      const { error } = await sb
        .from('owner_requests')
        .update({ escalation_round: round, next_escalation_at: nextAt.toISOString() } as never)
        .eq('id', requestId)
        .eq('status', 'open');
      if (error) throw new Error(`advance: ${error.message}`);
    },
    async logSms(tenantId, requestId, round, to, text, r) {
      await logNotification(sb, {
        tenantId,
        driverId: null,
        channel: 'sms',
        recipient: to,
        subject: 'Vehicle emergency',
        body: text,
        entityType: 'owner_request',
        entityId: requestId,
        dedupeKey: `escalation:${requestId}:${round}:sms:${to}`,
        status: r.sent ? 'sent' : r.skipped ? 'skipped' : 'failed',
        error: r.error ?? null,
      });
    },
    async audit(tenantId, requestId, detail) {
      await sb.rpc('log_audit', {
        p_tenant: tenantId,
        p_action: 'owner_request.escalated',
        p_entity_type: 'owner_request',
        p_entity_id: requestId,
        p_detail: detail as never,
      });
    },
  };
}

function pick(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
