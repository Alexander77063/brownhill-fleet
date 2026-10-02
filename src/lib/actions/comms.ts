'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { sendDriverMessage } from '@/lib/comms';

/** Ops sends an ad-hoc message to a driver (email + SMS where available). */
export async function messageDriverAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('drivers.write');
  const driverId = String(formData.get('driver_id') ?? '');
  const subject = String(formData.get('subject') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  if (!driverId) throw new Error('Missing driver');
  if (!subject) throw new Error('Please enter a subject.');
  if (!body) throw new Error('Please enter a message.');
  await sendDriverMessage(ctx.tenantId, driverId, subject, body, ctx.userId);
  revalidatePath(`/ops/drivers/${driverId}`);
}
