'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { isUploadedFile, uploadReceipt } from '@/lib/receipts';
import { attachChargeMedia } from '@/lib/charge-media';

/** Attach an image or video (dashcam) evidence clip to a charge. */
export async function attachChargeEvidenceAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  const chargeId = String(formData.get('charge_id') ?? '');
  if (!chargeId) throw new Error('Missing charge.');
  const file = formData.get('evidence');
  if (!isUploadedFile(file)) throw new Error('Please choose a file to upload.');

  const up = await uploadReceipt(file, `${ctx.tenantId}/charge/${chargeId}`);
  if (!up.path) throw new Error(up.warning ?? 'The file could not be stored.');
  const kind = file.type.startsWith('video/') ? 'video' : 'image';
  await attachChargeMedia(ctx.tenantId, chargeId, kind, up.path, ctx.userId);
  revalidatePath('/ops/charges');
}
