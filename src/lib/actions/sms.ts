'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { clearTenantSms, saveTenantSmsConfig } from '@/lib/sms/tenant-sms';

export async function saveTenantSmsAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  await saveTenantSmsConfig(
    ctx.tenantId,
    {
      enabled: formData.get('sms_enabled') === '1',
      accountSid: String(formData.get('account_sid') ?? '') || null,
      fromNumber: String(formData.get('from_number') ?? '') || null,
      authToken: String(formData.get('auth_token') ?? '') || null,
    },
    ctx.userId,
  );
  revalidatePath('/admin/notifications');
}

export async function clearTenantSmsAction(): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  await clearTenantSms(ctx.tenantId);
  revalidatePath('/admin/notifications');
}
