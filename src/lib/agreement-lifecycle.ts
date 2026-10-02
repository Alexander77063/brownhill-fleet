/**
 * Agreement completion — closing out a rental once its term is served.
 *
 * Before this existed nothing ever moved an agreement out of `active`: it stayed active
 * indefinitely, which meant the weekly rent cron kept invoicing past the end of the term
 * (it selects on `status = 'active'`, capped only by a 200-week safety limit). Flipping
 * the status to `ended` is therefore both the record-keeping fix and the billing fix.
 *
 * Two ways in:
 *   - `completeDueAgreements` — the daily cron, for terms that have run their course.
 *   - `completeAgreement`     — an ops override, for an early or negotiated ending.
 */

import { addDays, daysBetween } from '@/lib/cron';
import { notifyTenantOwner, sendDriverMessage } from '@/lib/comms';
import { createServiceClient } from '@/lib/supabase/server';

type Sb = ReturnType<typeof createServiceClient>;

export interface AgreementTermFields {
  start_date: string | null;
  end_date: string | null;
  term_weeks: number | null;
}

/**
 * The last day the agreement is meant to run.
 *
 * An explicit `end_date` always wins. Otherwise a term is derived from the start date —
 * week 1 is `start_date .. +6d`, matching how the rent cron anchors weeks, so an N-week
 * term ends on `start_date + N*7 - 1`.
 *
 * Returns null for an open-ended standard rental (no end date, no term). Those are never
 * auto-completed: there is no defined end, so ending one is a human decision.
 */
export function expectedEndDate(a: AgreementTermFields): string | null {
  if (a.end_date) return a.end_date;
  if (!a.start_date || !a.term_weeks || a.term_weeks <= 0) return null;
  return addDays(a.start_date, a.term_weeks * 7 - 1);
}

/** True when the agreement's term is fully served as of `today`. */
export function isTermServed(a: AgreementTermFields, today: string): boolean {
  const end = expectedEndDate(a);
  if (!end) return false;
  // daysBetween(end, today) >= 0 means today is on or after the final day; we require the
  // final day to have passed so the last week is billed in full.
  return daysBetween(end, today) > 0;
}

export type CompletionReason = 'term_served' | 'ops_override';

interface AgreementRow extends AgreementTermFields {
  id: string;
  type: 'standard' | 'rtb';
  status: string;
  driver_id: string;
  vehicle_id: string;
}

async function audit(sb: Sb, tenantId: string, agreementId: string, detail: Record<string, unknown>, actor?: string | null) {
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'agreement.completed',
    p_entity_type: 'agreement',
    p_entity_id: agreementId,
    p_detail: detail as never,
    p_actor: actor ?? undefined,
  });
}

/** Wording differs materially for rent-to-buy: the driver has finished buying the car. */
function completionMessage(type: 'standard' | 'rtb', registration: string | null): { subject: string; body: string } {
  const car = registration ? ` for ${registration}` : '';
  if (type === 'rtb') {
    return {
      subject: `Your rent-to-buy agreement${car} is complete`,
      body:
        `Congratulations — you have completed the full term of your rent-to-buy agreement${car}. ` +
        `No further weekly rent is due. We will be in touch about transferring ownership and finalising your equity balance.`,
    };
  }
  return {
    subject: `Your rental agreement${car} has ended`,
    body:
      `Your rental agreement${car} has reached the end of its term and is now closed. ` +
      `No further weekly rent will be charged. Please contact us to arrange the return of the vehicle, or to start a new agreement.`,
  };
}

/**
 * Close a single agreement and tell the driver and the operator.
 *
 * Idempotent by status: an agreement that is not `active` is left alone and reported as
 * not-changed, so a retried cron run cannot double-notify.
 */
export async function completeAgreement(
  tenantId: string,
  agreementId: string,
  reason: CompletionReason,
  actor?: string | null,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ completed: boolean; skippedReason?: string }> {
  const sb = createServiceClient();

  // Tenant-scoped: the service client bypasses RLS, so this filter is the isolation.
  const { data } = await sb
    .from('agreements')
    .select('id, type, status, driver_id, vehicle_id, start_date, end_date, term_weeks')
    .eq('id', agreementId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!data) throw new Error('Agreement not found in this organisation.');

  const ag = data as AgreementRow;
  if (ag.status !== 'active') {
    return { completed: false, skippedReason: `Agreement is already "${ag.status}".` };
  }

  const endOn = ag.end_date ?? expectedEndDate(ag) ?? today;

  const { error } = await sb
    .from('agreements')
    .update({ status: 'ended', end_date: endOn } as never)
    .eq('id', agreementId)
    .eq('tenant_id', tenantId)
    // Guard against a concurrent run having already closed it between our read and write.
    .eq('status', 'active');
  if (error) throw new Error(`Could not complete agreement: ${error.message}`);

  await audit(sb, tenantId, agreementId, { reason, end_date: endOn, type: ag.type }, actor);

  const { data: vehicle } = await sb
    .from('vehicles')
    .select('registration')
    .eq('id', ag.vehicle_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const registration = (vehicle as { registration: string } | null)?.registration ?? null;
  const { subject, body } = completionMessage(ag.type, registration);

  // Notification failures must not roll back the completion — the status change is the
  // source of truth, and every send is logged to `notifications` either way.
  try {
    await sendDriverMessage(tenantId, ag.driver_id, subject, body, actor);
  } catch {
    /* logged by sendDriverMessage */
  }
  await notifyTenantOwner(
    tenantId,
    `Agreement completed${registration ? ` — ${registration}` : ''}`,
    `${ag.type === 'rtb' ? 'Rent-to-buy' : 'Standard'} agreement ${agreementId.slice(0, 8)} reached its end date (${endOn}) and has been closed. Weekly rent generation has stopped.`,
    { entityType: 'agreement', entityId: agreementId, dedupeKey: `agreement.completed:${agreementId}` },
  );

  return { completed: true };
}

/**
 * Close every active agreement in a tenant whose term has been served.
 * Returns the number actually closed.
 */
export async function completeDueAgreements(tenantId: string, today: string): Promise<number> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('agreements')
    .select('id, type, status, driver_id, vehicle_id, start_date, end_date, term_weeks')
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  let closed = 0;
  for (const raw of (data ?? []) as AgreementRow[]) {
    if (!isTermServed(raw, today)) continue;
    const res = await completeAgreement(tenantId, raw.id, 'term_served', null, today);
    if (res.completed) closed++;
  }
  return closed;
}
