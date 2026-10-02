'use server';

import { revalidatePath } from 'next/cache';
import { getSessionProfile } from '@/lib/auth';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { submitDriverReceipt } from '@/lib/charges';
import { isUploadedFile, uploadReceipt } from '@/lib/receipts';
import { storagePut } from '@/lib/storage';
import { pounds } from '@/lib/money';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Upload an insurance certificate for the signed-in driver.
 *
 * Stores the file in the `insurance-certs` Storage bucket at
 * `${driverId}/${filename}` and inserts a `pending` certificate row. If the
 * bucket is missing (foundation prerequisite — it is not yet provisioned in any
 * migration/config) the upload is caught and the row is still created with a
 * null doc_path so ops can chase the document, and the caller is told.
 */
export async function uploadCertificate(formData: FormData): Promise<ActionResult> {
  const p = await getSessionProfile();
  if (!p?.driverId) return { ok: false, message: 'No active driver account.' };

  const insurer = String(formData.get('insurer') ?? '').trim();
  const policyNo = String(formData.get('policy_no') ?? '').trim();
  const coverFrom = String(formData.get('cover_from') ?? '').trim();
  const coverTo = String(formData.get('cover_to') ?? '').trim();

  if (!insurer || !policyNo || !coverFrom || !coverTo) {
    return { ok: false, message: 'Insurer, policy number and cover dates are required.' };
  }

  const file = formData.get('file');
  const hasFile = file instanceof File && file.size > 0;

  const sb = await createClient();

  // Resolve the driver's tenant so the certificate is attributed to the right
  // organisation. Omitting tenant_id is not a no-op: the column defaults to the
  // seed tenant, so another tenant's certificate would land in its books.
  const { data: drv } = await sb
    .from('drivers')
    .select('tenant_id')
    .eq('id', p.driverId)
    .maybeSingle();
  const tenantId = (drv as { tenant_id: string } | null)?.tenant_id;
  if (!tenantId) return { ok: false, message: 'Could not resolve your organisation.' };

  // Resolve the driver's active agreement to link the certificate (optional).
  const { data: ag } = await sb
    .from('agreements')
    .select('id')
    .eq('driver_id', p.driverId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  let docPath: string | null = null;
  let storageWarning = '';

  if (hasFile) {
    const f = file as File;
    const safeName = f.name.replace(/[^\w.\-]+/g, '_');
    const path = `${p.driverId}/${Date.now()}_${safeName}`;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const { ok } = await storagePut('insurance-certs', path, bytes, f.type || 'application/octet-stream');
    if (!ok) {
      // Deliberately does NOT name a cause. This used to say "(storage not configured)", which
      // was a guess — and precisely the wrong guess during the R2 outage that motivated this
      // work, where storage was configured and rejecting every write. Asserting a cause you have
      // not established sends whoever reads it to the wrong place. The real reason is logged by
      // `storagePut`.
      storageWarning = ' The file could not be stored — the record was saved without it.';
    } else {
      docPath = path;
    }
  }

  const { error: insErr } = await sb.from('insurance_certificates').insert({
    tenant_id: tenantId,
    driver_id: p.driverId,
    agreement_id: (ag as { id: string } | null)?.id ?? null,
    insurer,
    policy_no: policyNo,
    cover_from: coverFrom,
    cover_to: coverTo,
    status: 'pending',
    doc_path: docPath,
  });

  if (insErr) return { ok: false, message: `Could not save certificate: ${insErr.message}` };

  revalidatePath('/driver/insurance');
  return {
    ok: true,
    message: `Certificate submitted for verification.${storageWarning}`,
  };
}

/**
 * Submit a receipt photo against a tenant category (a toll, congestion charge,
 * PCN, fuel receipt…). A charge-kind category creates a `charges` row entering
 * the 48h lifecycle; an expense-kind category creates an `expenses` row. The
 * photo goes to the driver's own folder in the private `receipts` bucket. The
 * tenant and driver ids are resolved on the server, never from the form.
 */
export async function submitReceipt(formData: FormData): Promise<ActionResult> {
  const p = await getSessionProfile();
  if (!p?.driverId) return { ok: false, message: 'No active driver account.' };

  const categoryId = String(formData.get('category_id') ?? '');
  if (!categoryId) return { ok: false, message: 'Please choose a category.' };
  const vehicleId = String(formData.get('vehicle_id') ?? '') || null;
  const amount = Number(String(formData.get('amount') ?? '').replace(/[£,\s]/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, message: 'Please enter a valid amount.' };
  const reference = String(formData.get('reference') ?? '').trim() || null;
  const incidentOn = String(formData.get('incident_on') ?? '') || null;

  // Optional photo → driver's own folder; a missing bucket degrades gracefully.
  let docPath: string | null = null;
  let warning = '';
  const file = formData.get('receipt');
  if (isUploadedFile(file)) {
    const up = await uploadReceipt(file, p.driverId);
    docPath = up.path;
    if (up.warning) warning = ` ${up.warning}`;
  }

  try {
    const r = await submitDriverReceipt(p.driverId, {
      categoryId,
      vehicleId,
      amountPence: pounds(amount),
      reference,
      incidentOn,
      docPath,
    });
    revalidatePath('/driver/submit');
    revalidatePath('/driver/charges');
    return {
      ok: true,
      message: `Submitted — the office has been notified to review your ${r.kind}.${warning}`,
    };
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not submit.' };
  }
}

/**
 * Mark one of the signed-in driver's charges as disputed.
 *
 * Drivers have SELECT-only RLS on `charges` (migration 0012), so the normal
 * client's UPDATE would silently match zero rows. We use the service-role client
 * and enforce ownership + a valid status transition in the WHERE clause instead.
 */
export async function disputeCharge(id: string): Promise<ActionResult> {
  const p = await getSessionProfile();
  if (!p?.driverId) return { ok: false, message: 'No active driver account.' };

  const sb = createServiceClient();
  const { data, error } = await sb
    .from('charges')
    .update({ status: 'disputed' })
    .eq('id', id)
    .eq('driver_id', p.driverId)
    .in('status', ['received', 'driver_notified'])
    .select('id');

  if (error) return { ok: false, message: `Could not raise dispute: ${error.message}` };
  if (!data || data.length === 0) {
    return { ok: false, message: 'This charge can no longer be disputed.' };
  }

  revalidatePath('/driver/charges');
  return { ok: true, message: 'Dispute raised. Ops will review with the issuing authority.' };
}
