'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { addPermittedZone, deactivatePermittedZone, saveTrackingRules } from '@/lib/tracking-rules';

export async function saveTrackingRulesAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  await saveTrackingRules(
    ctx.tenantId,
    {
      outOfHoursEnabled: formData.get('out_of_hours_enabled') === '1',
      allowedFrom: String(formData.get('allowed_from') ?? '') || null,
      allowedTo: String(formData.get('allowed_to') ?? '') || null,
      timezone: String(formData.get('timezone') ?? 'Europe/London') || 'Europe/London',
      noBookingMovementEnabled: formData.get('no_booking_movement_enabled') === '1',
      permittedAreaEnabled: formData.get('permitted_area_enabled') === '1',
    },
    ctx.userId,
  );
  revalidatePath('/admin/tracking-rules');
}

export async function addPermittedZoneAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  await addPermittedZone(ctx.tenantId, {
    name: String(formData.get('name') ?? ''),
    lat: Number(formData.get('lat')),
    lng: Number(formData.get('lng')),
    radiusM: Number(formData.get('radius_m')) || 5000,
  });
  revalidatePath('/admin/tracking-rules');
}

export async function deactivatePermittedZoneAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  await deactivatePermittedZone(ctx.tenantId, String(formData.get('zone_id') ?? ''));
  revalidatePath('/admin/tracking-rules');
}
