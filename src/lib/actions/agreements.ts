'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { requireEntitlement } from '@/lib/entitlements';
import { completeAgreement } from '@/lib/agreement-lifecycle';

/**
 * Ops override: close an agreement now rather than waiting for the daily cron.
 *
 * Used for an early or negotiated ending — a driver handing the car back before term,
 * or a rental with no fixed term (which the cron never closes on its own, because there
 * is no defined end date to act on).
 */
export async function completeAgreementAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('agreements.write');
  await requireEntitlement('rental.core');
  const agreementId = String(formData.get('agreement_id') ?? '');
  await completeAgreement(ctx.tenantId, agreementId, 'ops_override', ctx.userId);
  revalidatePath('/ops/agreements');
  revalidatePath(`/ops/agreements/${agreementId}`);
}
