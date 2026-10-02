'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth';
import { getAuthContext } from '@/lib/auth/context';
import { syncBilledVehicles } from '@/lib/catalogue/quantity';
import { buildAdditionDraft, issueInvoice, todayISO } from '@/lib/collection/invoices';
import { deploymentProfile } from '@/lib/deployment/profile';
import { payFirst } from '@/lib/region';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isValidTimeZone } from '@/lib/timezone';

const str = (fd: FormData, k: string): string => String(fd.get(k) ?? '').trim();

/**
 * The owner edits their own contact details and alert thresholds. Runs as the
 * owner through the RLS client, so the self-update policy and the column guard
 * trigger (0060) are what decide what may change — not this file.
 */
export async function updateMySettingsAction(formData: FormData): Promise<void> {
  const p = await requireRole(['owner']);
  if (!p.vehicleOwnerId) throw new Error('No owner record is linked to this account.');
  const sb = await createClient();
  const speed = Number(str(formData, 'speed_limit_kph'));
  const offline = Number(str(formData, 'offline_after_h'));
  const tz = str(formData, 'timezone');
  if (tz && !isValidTimeZone(tz)) throw new Error('That timezone is not recognised. Use a name like Africa/Lagos.');
  const { error } = await sb
    .from('vehicle_owners')
    .update({
      name: str(formData, 'name') || undefined,
      email: str(formData, 'email') || null,
      timezone: tz || undefined,
      night_from: str(formData, 'night_from') || undefined,
      night_to: str(formData, 'night_to') || undefined,
      speed_limit_kph: Number.isFinite(speed) && speed > 0 ? speed : undefined,
      offline_after_h: Number.isFinite(offline) && offline > 0 ? offline : undefined,
      alerts_sms: formData.get('alerts_sms') === 'on',
    } as never)
    .eq('id', p.vehicleOwnerId);
  if (error) throw new Error(error.message);
  revalidatePath('/owner/settings');
}

/**
 * On the shared instance the owner is their own tenant and adds their own
 * vehicles. The insert names tenant and owner explicitly and then refreshes
 * the billed-vehicle count NG-1 introduced.
 */
export async function addMyVehicleAction(formData: FormData): Promise<void> {
  if (!deploymentProfile().selfServeSignup) throw new Error('Your insurer or fleet adds vehicles for you.');
  const p = await requireRole(['owner']);
  const ctx = await getAuthContext();
  if (!p.vehicleOwnerId || !ctx?.tenantId) throw new Error('No owner record is linked to this account.');

  const registration = str(formData, 'registration').toUpperCase();
  if (!registration) throw new Error('Enter the registration number.');
  const year = str(formData, 'model_year');

  const sb = createServiceClient();
  const { data: created, error } = await sb
    .from('vehicles')
    .insert({
      tenant_id: ctx.tenantId,
      owner_id: p.vehicleOwnerId,
      registration,
      make: str(formData, 'make') || undefined,
      model: str(formData, 'model') || undefined,
      colour: str(formData, 'colour') || null,
      model_year: year ? Number(year) : null,
      // An owner protecting their own car has no purchase price to declare.
      list_value_pence: 0,
      status: 'available',
    } as never)
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('That registration is already on the system.');
    throw new Error(error.message);
  }
  await syncBilledVehicles(ctx.tenantId).catch((e: unknown) => console.error('[billed_vehicles] sync failed', e));
  revalidatePath('/owner');

  // NG-2, pay-first: on an active subscription whose plan charges additions at
  // once, the new car raises its pro-rata invoice now and waits for payment;
  // before the first payment, the first invoice will simply include it.
  if (payFirst()) {
    const addition = await additionInvoiceFor(ctx.tenantId, (created as { id: string }).id, ctx.userId, sb).catch((e: unknown) => {
      console.error('[collection] addition invoice failed', e);
      return null;
    });
    if (addition) redirect(`/owner/billing?pay=${addition}`);
    const { data: sub } = await sb.from('tenant_subscription').select('status').eq('tenant_id', ctx.tenantId).maybeSingle();
    if (sub?.status === 'unpaid' || sub?.status === 'cancelled') redirect('/owner/billing');
  }
  redirect('/owner');
}

/** Issue the pro-rata + hardware invoice for one added vehicle, or null when nothing is due now. */
async function additionInvoiceFor(tenantId: string, vehicleId: string, actor: string, sb: ReturnType<typeof createServiceClient>): Promise<string | null> {
  const { data: sub } = await sb
    .from('tenant_subscription')
    .select('status, plan_id, current_period_start, anniversary_on, plans(additions_billing)')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const plan = (sub as unknown as { plans: { additions_billing: string } | null } | null)?.plans;
  if (!sub || sub.status !== 'active' || !sub.plan_id || !sub.anniversary_on || plan?.additions_billing !== 'immediate') return null;
  const today = todayISO();
  const period = { start: sub.current_period_start ?? today, end: sub.anniversary_on };
  const d = await buildAdditionDraft(tenantId, sub.plan_id, [vehicleId], period, sb, today);
  if (!d.lines.length) return null;
  const issued = await issueInvoice({ tenantId, kind: 'addition', planId: sub.plan_id, lines: d.lines, period, dueOn: today, currency: d.currency, vatRate: d.vatRate, actor, sb, today });
  return issued.id;
}
