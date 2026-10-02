'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { clearTenantEmail, saveTenantEmailConfig } from '@/lib/email/tenant-email';

export async function saveTenantEmailAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  await saveTenantEmailConfig(
    ctx.tenantId,
    {
      enabled: formData.get('email_enabled') === '1',
      fromAddress: String(formData.get('from_address') ?? '') || null,
      fromName: String(formData.get('from_name') ?? '') || null,
      replyTo: String(formData.get('reply_to') ?? '') || null,
      resendKey: String(formData.get('resend_api_key') ?? '') || null,
    },
    ctx.userId,
  );
  revalidatePath('/admin/notifications');
}

export async function clearTenantEmailAction(): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  await clearTenantEmail(ctx.tenantId);
  revalidatePath('/admin/notifications');
}
