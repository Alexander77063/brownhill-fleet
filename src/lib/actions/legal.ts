'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { requirePermission } from '@/lib/auth/context';
import { clientIpFrom } from '@/lib/auth/client-ip';
import { recordLegalAcceptance } from '@/lib/legal-consent';

/** Record the tenant's acceptance of the current legal version. Gated to owners/
 *  admins (tenant.settings) — they accept on behalf of the organisation. */
export async function acceptLegalAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  if (formData.get('agree') !== 'on') redirect('/legal/accept?error=1');
  // The address in the legal trail has to be the one nginx saw, not the one
  // the browser put in the header: nginx APPENDS the address it saw to
  // whatever the caller sent, so the first element of the list is the
  // caller's own claim. `clientIpFrom` takes the truth.
  const ip = clientIpFrom(await headers());
  await recordLegalAcceptance(ctx.tenantId, ctx.userId, ip);
  redirect('/ops');
}
