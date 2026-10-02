'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/context';
import {
  createCategory,
  recordExpense,
  setCategoryActive,
  setCategoryDriverSubmittable,
  setCategoryVatTreatment,
  VAT_TREATMENTS,
  type VatTreatment,
} from '@/lib/expenses';
import { isUploadedFile, uploadReceipt } from '@/lib/receipts';
import { pounds } from '@/lib/money';

export async function recordExpenseAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  const amount = Number(String(formData.get('amount') ?? '').replace(/[£,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Please enter a valid amount.');

  // Optional receipt image — stored under the tenant's folder; a missing bucket
  // degrades to a null path so the expense still records.
  let docPath: string | null = null;
  const receipt = formData.get('receipt');
  if (isUploadedFile(receipt)) {
    ({ path: docPath } = await uploadReceipt(receipt, ctx.tenantId));
  }

  await recordExpense(
    ctx.tenantId,
    {
      categoryId: String(formData.get('category_id') ?? '') || null,
      amountPence: pounds(amount),
      incurredOn: String(formData.get('incurred_on') ?? '') || undefined,
      description: String(formData.get('description') ?? '') || undefined,
      vehicleId: String(formData.get('vehicle_id') ?? '') || null,
      docPath,
    },
    ctx.userId,
  );
  revalidatePath('/ops/expenses');
}

export async function createCategoryAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  const vt = String(formData.get('vat_treatment') ?? 'standard');
  await createCategory(ctx.tenantId, String(formData.get('name') ?? ''), ctx.userId, {
    kind: formData.get('kind') === 'charge' ? 'charge' : 'expense',
    driverSubmittable: formData.get('driver_submittable') === '1',
    vatTreatment: (VAT_TREATMENTS as string[]).includes(vt) ? (vt as VatTreatment) : 'standard',
  });
  revalidatePath('/ops/expenses');
}

export async function setCategoryVatTreatmentAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  const vt = String(formData.get('vat_treatment') ?? 'standard');
  await setCategoryVatTreatment(
    ctx.tenantId,
    String(formData.get('category_id') ?? ''),
    (VAT_TREATMENTS as string[]).includes(vt) ? (vt as VatTreatment) : 'standard',
    ctx.userId,
  );
  revalidatePath('/ops/expenses');
}

export async function toggleCategoryAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  await setCategoryActive(ctx.tenantId, String(formData.get('category_id') ?? ''), formData.get('active') === '1', ctx.userId);
  revalidatePath('/ops/expenses');
}

export async function toggleCategoryDriverSubmittableAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('billing.write');
  await setCategoryDriverSubmittable(
    ctx.tenantId,
    String(formData.get('category_id') ?? ''),
    formData.get('submittable') === '1',
    ctx.userId,
  );
  revalidatePath('/ops/expenses');
}
