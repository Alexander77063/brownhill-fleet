'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { completeService, upsertSchedule } from '@/lib/maintenance';
import { pounds } from '@/lib/money';

export async function scheduleServiceAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('fleet.write');
  const vehicleId = String(formData.get('vehicle_id') ?? '');
  const nextDue = String(formData.get('next_due_on') ?? '');
  if (!vehicleId || !nextDue) throw new Error('Vehicle and next-due date are required.');
  const interval = Number(String(formData.get('interval_days') ?? '182')) || 182;
  await upsertSchedule(ctx.tenantId, vehicleId, String(formData.get('kind') ?? 'service') || 'service', interval, nextDue, ctx.userId);
  revalidatePath('/ops/maintenance');
}

export async function completeServiceAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('fleet.write');
  const cost = Number(String(formData.get('cost') ?? '0').replace(/[£,\s]/g, ''));
  await completeService(
    ctx.tenantId,
    String(formData.get('schedule_id') ?? ''),
    {
      doneOn: String(formData.get('done_on') ?? '') || new Date().toISOString().slice(0, 10),
      costPence: Number.isFinite(cost) ? pounds(cost) : 0,
      payer: (String(formData.get('payer') ?? 'company') === 'driver' ? 'driver' : 'company'),
    },
    ctx.userId,
  );
  revalidatePath('/ops/maintenance');
}
