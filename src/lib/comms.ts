/**
 * Comms — driver messaging + the reminders engine. Escalating reminders are
 * driven off the compliance obligations: a driver is notified when one of their
 * documents enters "due soon" and again when it turns critical/overdue, but never
 * spammed the same reminder twice (deduped on obligation + severity). Every send
 * is logged to `notifications` — including sends that were skipped because a
 * channel isn't configured — so the log is a complete, testable record.
 */

import { sendTenantEmail } from '@/lib/email/tenant-email';
import { sendTenantSms } from '@/lib/sms/tenant-sms';
import { createServiceClient } from '@/lib/supabase/server';

type Sb = ReturnType<typeof createServiceClient>;

// Obligations owned by the driver (they must act to renew).
const DRIVER_TYPES = ['insurance_expiry', 'pco_licence_expiry', 'dvla_check'] as const;

interface LogInput {
  tenantId: string;
  driverId: string | null;
  channel: 'email' | 'sms';
  recipient: string | null;
  subject: string | null;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey?: string | null;
  status: 'sent' | 'skipped' | 'failed';
  error?: string | null;
}

export async function logNotification(sb: Sb, n: LogInput): Promise<void> {
  await sb
    .from('notifications')
    .insert({
      tenant_id: n.tenantId,
      driver_id: n.driverId,
      channel: n.channel,
      recipient: n.recipient,
      subject: n.subject,
      body: n.body,
      entity_type: n.entityType ?? null,
      entity_id: n.entityId ?? null,
      dedupe_key: n.dedupeKey ?? null,
      status: n.status,
      error: n.error ?? null,
    } as never);
}

function statusOf(res: { sent: boolean; skipped?: boolean; error?: string }): {
  status: LogInput['status'];
  error: string | null;
} {
  if (res.sent) return { status: 'sent', error: null };
  if (res.skipped) return { status: 'skipped', error: null };
  return { status: 'failed', error: res.error ?? 'failed' };
}

async function alreadyReminded(sb: Sb, tenantId: string, dedupeKey: string): Promise<boolean> {
  const { data } = await sb
    .from('notifications')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  return !!data;
}

/** Send a one-off message to a driver via whatever channels we have, and log it. */
export async function sendDriverMessage(
  tenantId: string,
  driverId: string,
  subject: string,
  body: string,
  actor?: string | null,
): Promise<{ channels: number }> {
  const sb = createServiceClient();
  // Tenant-scope the lookup: a driver from another tenant must not be reachable
  // even though the service client bypasses RLS.
  const { data: driver } = await sb
    .from('drivers')
    .select('email, phone')
    .eq('id', driverId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!driver) throw new Error('Driver not found in this organisation.');
  let channels = 0;
  if (driver?.email) {
    const res = await sendTenantEmail(tenantId,driver.email, subject, `<p>${body}</p>`);
    await logNotification(sb, { tenantId, driverId, channel: 'email', recipient: driver.email, subject, body, ...statusOf(res) });
    channels++;
  }
  if (driver?.phone) {
    const res = await sendTenantSms(tenantId,driver.phone, `${subject}: ${body}`);
    await logNotification(sb, { tenantId, driverId, channel: 'sms', recipient: driver.phone, subject, body, ...statusOf(res) });
    channels++;
  }
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'comms.driver_message',
    p_entity_type: 'driver',
    p_entity_id: driverId,
    p_detail: { subject } as never,
    p_actor: actor ?? undefined,
  });
  return { channels };
}

/**
 * Notify the tenant's owner by email (dormant-safe) and log it. `driver_id` is
 * null — the recipient is the operator, not a driver. When a `dedupeKey` is given
 * the send fires at most once per key (used by the overdue-charge chase).
 */
export async function notifyTenantOwner(
  tenantId: string,
  subject: string,
  body: string,
  opts: { entityType?: string; entityId?: string; dedupeKey?: string } = {},
): Promise<{ sent: boolean; logged: boolean }> {
  const sb = createServiceClient();
  if (opts.dedupeKey && (await alreadyReminded(sb, tenantId, opts.dedupeKey))) return { sent: false, logged: false };

  const { data: owner } = await sb
    .from('tenant_memberships')
    .select('profiles(email)')
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  const email = (owner as { profiles?: { email?: string | null } } | null)?.profiles?.email ?? null;

  const base = {
    tenantId,
    driverId: null,
    channel: 'email' as const,
    subject,
    body,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId ?? null,
    dedupeKey: opts.dedupeKey ?? null,
  };
  if (!email) {
    // No owner email on file — log a skipped record so the trail is complete.
    await logNotification(sb, { ...base, recipient: null, status: 'skipped', error: 'no owner email' });
    return { sent: false, logged: true };
  }
  const res = await sendTenantEmail(tenantId, email, subject, `<p>${body}</p>`);
  await logNotification(sb, { ...base, recipient: email, ...statusOf(res) });
  return { sent: res.sent, logged: true };
}

/**
 * Message a driver — email preferred, else SMS — and log it, optionally deduped so
 * a reminder fires at most once per key. One channel per send keeps the single
 * `unique(tenant_id, dedupe_key)` row intact (mirrors `sendObligationReminders`).
 * `logged` reports whether a new row was written (false when deduped or the driver
 * isn't in this tenant) — the chase/reminder counters use it.
 */
export async function notifyDriverLogged(
  tenantId: string,
  driverId: string,
  subject: string,
  body: string,
  opts: { entityType?: string; entityId?: string; dedupeKey?: string } = {},
): Promise<{ sent: boolean; logged: boolean }> {
  const sb = createServiceClient();
  if (opts.dedupeKey && (await alreadyReminded(sb, tenantId, opts.dedupeKey))) return { sent: false, logged: false };

  const { data: driver } = await sb
    .from('drivers')
    .select('email, phone')
    .eq('id', driverId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!driver) return { sent: false, logged: false };
  const d = driver as { email: string | null; phone: string | null };

  const base = {
    tenantId,
    driverId,
    subject,
    body,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId ?? null,
    dedupeKey: opts.dedupeKey ?? null,
  };
  if (d.email) {
    const res = await sendTenantEmail(tenantId,d.email, subject, `<p>${body}</p>`);
    await logNotification(sb, { ...base, channel: 'email', recipient: d.email, ...statusOf(res) });
    return { sent: res.sent, logged: true };
  }
  if (d.phone) {
    const res = await sendTenantSms(tenantId,d.phone, `${subject}: ${body}`);
    await logNotification(sb, { ...base, channel: 'sms', recipient: d.phone, ...statusOf(res) });
    return { sent: res.sent, logged: true };
  }
  // No channel — claim the dedupe key with a skipped row so the trail is complete.
  await logNotification(sb, { ...base, channel: 'email', recipient: null, status: 'skipped', error: 'no channel' });
  return { sent: false, logged: true };
}

/**
 * Send reminders for the tenant's due/overdue driver documents. Deduped on
 * (obligation, severity) so escalation only fires once per level. Returns how
 * many reminders were newly sent.
 */
export async function sendObligationReminders(tenantId: string): Promise<number> {
  const sb = createServiceClient();
  const { data: obs } = await sb
    .from('obligations')
    .select('id, entity_id, type, title, due_date, status, severity')
    .eq('tenant_id', tenantId)
    .eq('entity_type', 'driver')
    .in('status', ['due_soon', 'overdue'])
    .in('type', [...DRIVER_TYPES]);

  let sent = 0;
  for (const o of (obs ?? []) as {
    id: string;
    entity_id: string;
    type: string;
    title: string;
    due_date: string;
    status: string;
    severity: string;
  }[]) {
    const dedupeKey = `${o.id}:${o.severity}`;
    if (await alreadyReminded(sb, tenantId, dedupeKey)) continue;

    const { data: driver } = await sb
      .from('drivers')
      .select('email, phone')
      .eq('id', o.entity_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const subject =
      o.status === 'overdue' ? `Overdue: ${o.title}` : `Action needed by ${o.due_date}: ${o.title}`;
    const body = `${o.title}. Please renew and send us the updated document to stay on the road.`;

    let logged = false;
    if (driver?.email) {
      const res = await sendTenantEmail(tenantId,driver.email, subject, `<p>${body}</p>`);
      await logNotification(sb, {
        tenantId,
        driverId: o.entity_id,
        channel: 'email',
        recipient: driver.email,
        subject,
        body,
        entityType: 'obligation',
        entityId: o.id,
        dedupeKey,
        ...statusOf(res),
      });
      logged = true;
    } else if (driver?.phone) {
      const res = await sendTenantSms(tenantId,driver.phone, `${subject}`);
      await logNotification(sb, {
        tenantId,
        driverId: o.entity_id,
        channel: 'sms',
        recipient: driver.phone,
        subject,
        body,
        entityType: 'obligation',
        entityId: o.id,
        dedupeKey,
        ...statusOf(res),
      });
      logged = true;
    }
    if (logged) sent++;
  }
  return sent;
}

export interface NotificationRow {
  id: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  status: string;
  created_at: string;
}

export async function listDriverNotifications(tenantId: string, driverId: string): Promise<NotificationRow[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('notifications')
    .select('id, channel, recipient, subject, status, created_at')
    .eq('tenant_id', tenantId)
    .eq('driver_id', driverId)
    .order('created_at', { ascending: false })
    .limit(20);
  return (data ?? []) as NotificationRow[];
}
