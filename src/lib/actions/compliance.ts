'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { markTflUploaded, syncComplianceObligations } from '@/lib/compliance';
import { todayISO } from '@/lib/cron';

/** Rebuild the document-compliance obligations on demand (ops). */
export async function refreshObligationsAction(): Promise<void> {
  const ctx = await requirePermission('compliance.write');
  await syncComplianceObligations(ctx.tenantId, todayISO());
  revalidatePath('/ops/compliance');
}

/** Record that this week's TfL compliance upload has been done. */
export async function markTflUploadedAction(): Promise<void> {
  const ctx = await requirePermission('compliance.write');
  await markTflUploaded(ctx.tenantId, todayISO(), ctx.userId);
  revalidatePath('/ops/compliance');
}
