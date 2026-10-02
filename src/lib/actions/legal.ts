'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { requirePermission } from '@/lib/auth/context';
import { recordLegalAcceptance } from '@/lib/legal-consent';

/** Record the tenant's acceptance of the current legal version. Gated to owners/
 *  admins (tenant.settings) — they accept on behalf of the organisation. */
export async function acceptLegalAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  if (formData.get('agree') !== 'on') redirect('/legal/accept?error=1');
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  await recordLegalAcceptance(ctx.tenantId, ctx.userId, ip);
  redirect('/ops');
}
