'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import { recordFuelLog } from '@/lib/fuel-log';
import { toPaymentMethod } from '@/lib/fuel';
import { isUploadedFile, uploadReceipt } from '@/lib/receipts';

/**
 * Parse a money amount typed by a person into integer minor units.
 *
 * Accepts what people actually type — currency symbols, thousands separators,
 * stray spaces — because rejecting "₦12,500" as invalid teaches them to fight
 * the form rather than use it.
 */
function toMinorUnits(raw: string): number {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const major = Number(cleaned);
  if (!Number.isFinite(major) || major <= 0) {
    throw new Error('Enter the amount paid, for example 12500.');
  }
  return Math.round(major * 100);
}

export async function recordFuelAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');

  const vehicleId = String(formData.get('vehicle_id') ?? '');
  if (!vehicleId) throw new Error('Choose the vehicle that was filled.');

  const litres = Number(String(formData.get('litres') ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(litres) || litres <= 0) {
    throw new Error('Enter how many litres went in.');
  }

  const costMinor = toMinorUnits(String(formData.get('cost') ?? ''));

  // The odometer is optional but load-bearing: without it this fill cannot be
  // joined to a distance, so it contributes to spend and to nothing else. The
  // screen says so rather than pretending the entry is complete.
  const odometerRaw = String(formData.get('odometer_km') ?? '').replace(/[^\d]/g, '');
  const odometerKm = odometerRaw ? Number(odometerRaw) : null;

  let receiptPath: string | null = null;
  const receipt = formData.get('receipt');
  if (isUploadedFile(receipt)) {
    ({ path: receiptPath } = await uploadReceipt(receipt, ctx.tenantId));
  }

  await recordFuelLog(
    ctx.tenantId,
    {
      vehicleId,
      driverId: String(formData.get('driver_id') ?? '') || null,
      litres,
      costMinor,
      odometerKm,
      filledAt: String(formData.get('filled_at') ?? '') || undefined,
      station: String(formData.get('station') ?? '') || null,
      paymentMethod: toPaymentMethod(String(formData.get('payment_method') ?? '')),
      note: String(formData.get('note') ?? '') || null,
      receiptPath,
    },
    ctx.userId,
  );

  revalidatePath('/ops/fuel');
}
