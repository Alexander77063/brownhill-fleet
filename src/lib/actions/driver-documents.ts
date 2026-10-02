'use server';

import { revalidatePath } from 'next/cache';
import { getSessionProfile } from '@/lib/auth';
import { getAuthContext, requirePermission } from '@/lib/auth/context';
import {
  allowsReferenceOnly,
  deleteDriverDocument,
  isDocumentKind,
  recordDriverReference,
  uploadDriverDocument,
  type UploadDocumentInput,
} from '@/lib/driver-documents';

function readInput(formData: FormData): Omit<UploadDocumentInput, 'kind'> & { kind: string } {
  return {
    kind: String(formData.get('kind') ?? ''),
    file: formData.get('file') as File,
    title: String(formData.get('title') ?? '') || undefined,
    reference: String(formData.get('reference') ?? '') || undefined,
    issuedOn: String(formData.get('issued_on') ?? '') || undefined,
    expiresOn: String(formData.get('expires_on') ?? '') || undefined,
  };
}

/**
 * Was a file actually attached?
 *
 * An empty file input still posts a `File` with size 0, so its presence proves
 * nothing.
 */
function hasFile(file: unknown): file is File {
  return file instanceof File && file.size > 0;
}

/**
 * Store the document, as a file or as a reference.
 *
 * The form cannot know which it is: whether a kind needs a file is the region
 * pack's business, and the type is only chosen once the operator picks it. So
 * the decision is made here — a file means an upload; no file means a
 * reference-only record, which `recordDriverReference` refuses unless this
 * region says that kind is a number rather than a document.
 */
async function saveDocument(
  tenantId: string,
  driverId: string,
  input: ReturnType<typeof readInput> & { kind: string },
  actor: string | null,
  writeThrough: boolean,
): Promise<void> {
  if (!hasFile(input.file) && allowsReferenceOnly(input.kind)) {
    await recordDriverReference(
      tenantId,
      driverId,
      { kind: input.kind, reference: input.reference ?? '', title: input.title, issuedOn: input.issuedOn },
      actor,
    );
    return;
  }
  await uploadDriverDocument(tenantId, driverId, { ...input, kind: input.kind }, actor, {
    writeThrough,
  });
}

/** Ops uploading a document on a driver's behalf. */
export async function uploadDriverDocumentAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('drivers.write');
  const driverId = String(formData.get('driver_id') ?? '');
  const input = readInput(formData);
  if (!isDocumentKind(input.kind)) throw new Error('Choose a document type.');

  // Trusted: an ops upload also updates the driver's licence/DVLA fields.
  await saveDocument(ctx.tenantId, driverId, input, ctx.userId, true);
  revalidatePath(`/ops/drivers/${driverId}`);
  revalidatePath('/ops/drivers');
  revalidatePath('/ops/compliance');
}

export async function deleteDriverDocumentAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('drivers.write');
  const driverId = String(formData.get('driver_id') ?? '');
  await deleteDriverDocument(ctx.tenantId, String(formData.get('document_id') ?? ''), ctx.userId);
  revalidatePath(`/ops/drivers/${driverId}`);
}

/**
 * A driver uploading their own document from the driver portal.
 *
 * Scoped to the signed-in driver's own id rather than anything in the form, so a driver
 * cannot attach a document to someone else's record.
 */
export async function uploadMyDocumentAction(formData: FormData): Promise<void> {
  // The driver link lives on the profile; the tenant comes from the auth context.
  const [profile, ctx] = await Promise.all([getSessionProfile(), getAuthContext()]);
  if (!profile?.driverId) throw new Error('No driver record is linked to your account.');
  if (!ctx?.tenantId) throw new Error('Your account is not linked to an organisation.');

  const input = readInput(formData);
  if (!isDocumentKind(input.kind)) throw new Error('Choose a document type.');

  // Deliberately NOT trusted: a driver's own upload is stored and visible to ops, but does
  // not touch `drivers.pco_licence_expiry` / `dvla_checked_on`. Those gate whether the
  // driver can be dispatched, so a driver must not be able to self-declare a date that
  // clears a roadworthiness blocker. Ops re-uploads (or edits the record) to confirm —
  // the same trust model `insurance_certificates` already uses via its verified/pending
  // status.
  await saveDocument(ctx.tenantId, profile.driverId, input, ctx.userId, false);
  revalidatePath('/driver/documents');
}
