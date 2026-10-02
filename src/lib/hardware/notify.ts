/**
 * What we tell the customer and the installer at each step of a hardware job.
 * Texts are GSM-7 safe (plain ASCII) and short; every send is logged against
 * the job so the console can show "we told them".
 */
import { logNotification } from '@/lib/comms';
import { regionProvider } from '@/lib/region';
import { platformSms } from '@/lib/sms/platform-sms';
import { createServiceClient } from '@/lib/supabase/server';
import type { JobKind } from './derive';

type Sb = ReturnType<typeof createServiceClient>;

export const KIND_NOUN: Record<JobKind, string> = {
  install: 'tracker fitting',
  replace: 'tracker replacement',
  remove: 'tracker removal',
  service: 'tracker service visit',
};

/** "Tue 9 Sep, 10:30" in the region's zone (the customer's clock, not the server's). */
export function whenText(iso: string, timeZone: string = regionProvider().timezone): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

export function jobsCreatedText(brand: string, registrations: string[], slaDays: number): string {
  const regs = registrations.join(', ');
  const noun = registrations.length === 1 ? 'your tracker' : 'your trackers';
  return `${brand}: payment received. We will call you within ${slaDays} days to fit ${noun} on ${regs}.`;
}

export function scheduledCustomerText(brand: string, registration: string, kind: JobKind, whenIso: string, installerName: string): string {
  return `${brand}: ${KIND_NOUN[kind]} for ${registration} is booked for ${whenText(whenIso)}. ${installerName} will call you before arriving.`;
}

export function scheduledInstallerText(
  brand: string,
  job: { registration: string; make: string | null; kind: JobKind; whenIso: string; address: string | null; contactName: string | null; contactPhone: string | null },
): string {
  const vehicle = job.make ? `${job.registration} (${job.make})` : job.registration;
  const where = job.address ? ` at ${job.address}` : '';
  const contact = [job.contactName, job.contactPhone].filter(Boolean).join(' ');
  return `${brand} job: ${KIND_NOUN[job.kind]} on ${vehicle}, ${whenText(job.whenIso)}${where}. Contact: ${contact || 'see ops'}. Call ops if you cannot attend.`;
}

export function completedCustomerText(brand: string, registration: string, kind: JobKind): string {
  switch (kind) {
    case 'install':
      return `${brand}: tracker fitted on ${registration}. Your car is now live in the app.`;
    case 'replace':
      return `${brand}: tracker replaced on ${registration}. Your car is live in the app again.`;
    case 'remove':
      return `${brand}: tracker removed from ${registration}. Tracking for this car has ended.`;
    case 'service':
      return `${brand}: tracker on ${registration} has been serviced and is reporting again.`;
  }
}

/** The person we text about a vehicle's job: its owner, else the billing contact, else the first owner. */
export async function customerPhoneFor(sb: Sb, tenantId: string, vehicleId: string | null): Promise<string | null> {
  if (vehicleId) {
    const { data: v } = await sb.from('vehicles').select('owner_id, vehicle_owners(phone)').eq('tenant_id', tenantId).eq('id', vehicleId).maybeSingle();
    const owner = pick(v?.vehicle_owners) as { phone: string | null } | null;
    if (owner?.phone) return owner.phone;
  }
  const [{ data: sub }, { data: first }] = await Promise.all([
    sb.from('tenant_subscription').select('billing_phone').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('vehicle_owners').select('phone').eq('tenant_id', tenantId).order('created_at').limit(1).maybeSingle(),
  ]);
  return sub?.billing_phone || first?.phone || null;
}

/** Send one SMS about a job and log it, whatever happened. Never throws. */
export async function smsAboutJob(
  sb: Sb,
  a: { tenantId: string; jobId: string; to: string | null; text: string; subject: string; audience: 'customer' | 'installer' },
): Promise<boolean> {
  if (!a.to) {
    await logNotification(sb, { tenantId: a.tenantId, driverId: null, channel: 'sms', recipient: null, subject: a.subject, body: a.text, entityType: 'hardware_job', entityId: a.jobId, dedupeKey: `hw:${a.jobId}:${a.audience}:${a.subject}:${Date.now()}`, status: 'skipped', error: 'no phone number' });
    return false;
  }
  const r = await platformSms(a.to, a.text, { channel: 'dnd' }).catch((e: unknown) => ({ sent: false, skipped: false, error: e instanceof Error ? e.message : 'failed' }));
  await logNotification(sb, {
    tenantId: a.tenantId,
    driverId: null,
    channel: 'sms',
    recipient: a.to,
    subject: a.subject,
    body: a.text,
    entityType: 'hardware_job',
    entityId: a.jobId,
    dedupeKey: `hw:${a.jobId}:${a.audience}:${a.subject}:${Date.now()}`,
    status: r.sent ? 'sent' : 'skipped' in r && r.skipped ? 'skipped' : 'failed',
    error: 'error' in r ? (r.error ?? null) : null,
  });
  return r.sent;
}

function pick(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
