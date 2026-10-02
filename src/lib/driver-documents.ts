/**
 * Driver documents — one place to add any document about a driver.
 *
 * Replaces three unrelated ways of "adding a document": typing a PCO expiry into a
 * scalar column with no file attached, uploading an insurance certificate through its
 * own bespoke form, and ticking a TfL boolean.
 *
 * The important design decision is **write-through**: uploading a PCO licence also sets
 * `drivers.pco_licence_expiry` (and the badge number), and a DVLA check sets
 * `drivers.dvla_checked_on`. That means the existing compliance engine, the blocking
 * rules in `BLOCKING_TYPES`, and the drivers list all keep working untouched, while ops
 * staff now have a single upload flow instead of remembering which field lives where.
 *
 * Files live in the private `driver-docs` bucket; a signed URL is only ever minted from
 * a row already resolved against the caller's tenant, never from a client-supplied path.
 */

import { createServiceClient } from '@/lib/supabase/server';
import { storagePut } from '@/lib/storage';
import { regionProvider } from '@/lib/region';
import { storageHome, type ObligationSpec } from '@/lib/region/types';

export const DOCUMENT_BUCKET = 'driver-docs';

/**
 * A document kind is a `driver_documents.kind` value. Since 0056 the column is
 * free text, because the vocabulary belongs to the region pack — the same
 * decision 0055 made for `vehicle_compliance.obligation_key`. Validation lives
 * here instead, in `isDocumentKind`.
 */
export type DocumentKind = string;

/**
 * Kinds that are not a country's compliance obligation but that every operator
 * files anyway. These are not in the region packs because they are not what a
 * jurisdiction requires of a driver; they are the paperwork of employing one.
 */
const UNIVERSAL_KINDS = ['right_to_work', 'proof_of_address', 'other'] as const;

const UNIVERSAL_LABELS: Record<string, string> = {
  right_to_work: 'Right to work',
  proof_of_address: 'Proof of address',
  other: 'Other document',
  dvla_check: 'Licence check',
};

/**
 * Universal kinds whose expiry date is the point of holding them.
 *
 * Kept as its own list rather than derived: these are outside the region packs,
 * so deriving "needs an expiry" from `mandatory && cadence` would silently stop
 * requiring one for right to work, weakening a rule the UK build relies on.
 */
const UNIVERSAL_EXPIRY_EXPECTED: readonly string[] = ['right_to_work'];

/** The document kind recording a national licence re-check, where one exists. */
export const LICENCE_RECHECK_KIND = 'dvla_check';

/** The region's driver obligations, as a lookup. */
function driverSpecs(): Map<string, ObligationSpec> {
  return new Map(regionProvider().driverCompliance.map((o) => [o.key, o] as const));
}

/**
 * Every kind the compliance planner should consider, as obligation specs.
 *
 * The region's own list, plus the universal kinds as non-mandatory specs. They
 * are synthesised rather than added to the packs because they are not a
 * jurisdiction's requirement — but without them the planner would drop an
 * expiring right-to-work document entirely, which today does raise a reminder.
 * Non-mandatory means they land on the advisory type and never block dispatch,
 * which is the behaviour that already exists.
 *
 * `dvla_check` is deliberately absent: the licence re-check has its own
 * obligation type, computed from an interval on the driver record, and planning
 * it here would raise a second one for the same thing.
 */
export function plannableDriverSpecs(): ObligationSpec[] {
  return [
    ...regionProvider().driverCompliance,
    ...UNIVERSAL_KINDS.map(
      (key): ObligationSpec => ({
        key,
        label: UNIVERSAL_LABELS[key],
        cadence: 'variable',
        mandatory: false,
        authority: '',
      }),
    ),
  ];
}

/**
 * Every kind that can be filed on this build: what the country requires of a
 * driver, plus the universal paperwork, plus the licence re-check where the
 * region has one. A Nigerian install offers NIN, FRSC licence and LASDRI card;
 * a UK install offers PCO licence, driving licence and DBS.
 */
export function documentKinds(): DocumentKind[] {
  const region = regionProvider();
  const recheck = region.driverLicenceRecheck ? [LICENCE_RECHECK_KIND] : [];
  return [...region.driverCompliance.map((o) => o.key), ...recheck, ...UNIVERSAL_KINDS];
}

/** What each kind is called here. */
export function documentLabel(kind: DocumentKind): string {
  if (kind === LICENCE_RECHECK_KIND) {
    return regionProvider().driverLicenceRecheck?.label ?? UNIVERSAL_LABELS[kind];
  }
  return driverSpecs().get(kind)?.label ?? UNIVERSAL_LABELS[kind] ?? kind;
}

/** Labels for every kind this build offers, for the upload form. */
export function documentLabels(): Record<string, string> {
  return Object.fromEntries(documentKinds().map((k) => [k, documentLabel(k)] as const));
}

/**
 * Kinds where an expiry date is what makes the document useful — prompt for it,
 * and refuse the upload without one.
 *
 * A mandatory region document that renews carries the date its renewal reminder
 * is built on; a `once` document (a Nigerian NIN) has no expiry to give.
 */
export function expiryExpected(): DocumentKind[] {
  const fromRegion = regionProvider()
    .driverCompliance.filter((o) => o.mandatory && o.cadence !== 'once')
    .map((o) => o.key);
  return [...fromRegion, ...UNIVERSAL_EXPIRY_EXPECTED];
}

/**
 * True when this document may be recorded as a reference with no file attached.
 *
 * A Nigerian NIN is eleven digits issued once; there is frequently nothing to
 * photograph. Forcing a file means the operator either cannot record it or
 * attaches something arbitrary, and an arbitrary attachment is worse than none
 * because it looks like evidence.
 */
export function allowsReferenceOnly(kind: DocumentKind): boolean {
  return driverSpecs().get(kind)?.cadence === 'once';
}

export interface DriverDocument {
  id: string;
  driver_id: string;
  kind: DocumentKind;
  title: string | null;
  doc_path: string | null;
  reference: string | null;
  issued_on: string | null;
  expires_on: string | null;
  status: 'active' | 'superseded';
  created_at: string;
}

/**
 * Region-aware validation. A kind this country does not use is refused rather
 * than stored: the sweep would never grade it, so the operator would believe a
 * document was tracked when nothing was watching it.
 */
export function isDocumentKind(value: string): value is DocumentKind {
  return documentKinds().includes(value);
}

/**
 * Whether `next` is a later date than the one already held (or the first one recorded).
 *
 * Used to make the write-through to the driver's compliance columns monotonic: uploading
 * an old or expired document for the record must never drag a date backwards and re-raise
 * a blocking obligation the driver has already cleared. ISO dates compare correctly as
 * strings, so no Date parsing is involved.
 */
export function advancesDate(next: string | null | undefined, held: string | null): boolean {
  if (!next) return false;
  return !held || next > held;
}

export interface UploadDocumentInput {
  kind: DocumentKind;
  file: File;
  title?: string;
  reference?: string;
  issuedOn?: string;
  expiresOn?: string;
}

/**
 * Store a document and, where the kind has a dedicated field on `drivers`, keep that
 * field in step so the compliance engine needs no changes.
 *
 * Any previously-active document of the same kind becomes `superseded`, so "the current
 * PCO licence" is always a single row without losing the history.
 */
export async function uploadDriverDocument(
  tenantId: string,
  driverId: string,
  input: UploadDocumentInput,
  actor: string | null,
  opts: { writeThrough?: boolean } = {},
): Promise<{ id: string }> {
  if (!input.file || input.file.size === 0) throw new Error('Choose a file to upload.');
  // Kinds whose whole purpose is the renewal date must carry one, otherwise the
  // document silently stops driving the reminder it exists for — and, for a PCO
  // licence, would leave a stale expiry on the driver record with nothing to correct it.
  if (expiryExpected().includes(input.kind) && !input.expiresOn) {
    throw new Error(`An expiry date is required for a ${documentLabel(input.kind).toLowerCase()}.`);
  }
  // Matches the 2 MB ceiling used by the logo uploader.
  if (input.file.size > 10 * 1024 * 1024) throw new Error('That file is larger than 10 MB.');

  const sb = createServiceClient();
  // Tenant-scope the driver lookup: the service client bypasses RLS, so this filter is
  // the only thing stopping a document being attached to another tenant's driver.
  const { data: driver } = await sb
    .from('drivers')
    .select('id')
    .eq('id', driverId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!driver) throw new Error('Driver not found in this organisation.');

  const safeName = input.file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
  const path = `${driverId}/${crypto.randomUUID()}-${safeName}`;
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const { ok, reason } = await storagePut(
    DOCUMENT_BUCKET,
    path,
    bytes,
    input.file.type || 'application/octet-stream',
  );
  if (!ok) {
    // "Please try again" is a lie when the cause is a missing bucket or a rejected key —
    // retrying then fails identically for ever. An ops upload (`writeThrough`) is made by
    // staff in the back office, so it gets the backend's own words, which name the fault and
    // turn "it is broken" into a five-minute fix. A driver uploading their own licence gets
    // the plain sentence: infrastructure detail is noise they cannot act on. Either way it is
    // logged server-side by `storagePut`.
    throw new Error(
      opts.writeThrough && reason
        ? `Could not store the file: ${reason}`
        : 'Could not store the file. Please try again.',
    );
  }

  const inserted = await supersedeAndInsert(tenantId, driverId, input, path, actor);

  // Only a trusted (ops) upload updates the driver's compliance fields — see
  // applyWriteThrough. A driver's own upload is stored and shown, but does not move
  // anything that gates dispatch.
  if (opts.writeThrough) await applyWriteThrough(tenantId, driverId, input);

  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'driver_document.uploaded',
    p_entity_type: 'driver',
    p_entity_id: driverId,
    p_detail: { kind: input.kind, expires_on: input.expiresOn ?? null } as never,
    p_actor: actor ?? undefined,
  });

  return { id: inserted.id };
}

/**
 * Supersede the previous document of this kind and insert the new one.
 *
 * Shared by the file upload and the reference-only path so "the current NIN" is
 * a single row either way, without losing the history.
 */
async function supersedeAndInsert(
  tenantId: string,
  driverId: string,
  input: { kind: DocumentKind; title?: string; reference?: string; issuedOn?: string; expiresOn?: string },
  path: string | null,
  actor: string | null,
): Promise<{ id: string }> {
  const sb = createServiceClient();
  await sb
    .from('driver_documents')
    .update({ status: 'superseded' } as never)
    .eq('tenant_id', tenantId)
    .eq('driver_id', driverId)
    .eq('kind', input.kind)
    .eq('status', 'active');

  const { data: inserted, error } = await sb
    .from('driver_documents')
    .insert({
      tenant_id: tenantId,
      driver_id: driverId,
      kind: input.kind,
      title: input.title?.trim() || null,
      doc_path: path,
      reference: input.reference?.trim() || null,
      issued_on: input.issuedOn || null,
      expires_on: input.expiresOn || null,
      status: 'active',
      uploaded_by: actor,
    } as never)
    .select('id')
    .single();
  if (error || !inserted) {
    throw new Error(`Could not save the document: ${error?.message ?? 'unknown error'}`);
  }
  return inserted as { id: string };
}

export interface RecordReferenceInput {
  kind: DocumentKind;
  reference: string;
  title?: string;
  issuedOn?: string;
}

/**
 * Record a document that is a number rather than a file.
 *
 * Deliberately a separate entry point from `uploadDriverDocument` rather than a
 * flag on it: that function's guards — a non-empty file, a size ceiling, a
 * storage write that must succeed before anything is inserted — are all about
 * the file, and threading "unless there isn't one" through each of them would
 * weaken the path that does have one.
 *
 * Only kinds the region marks `cadence: 'once'` may be recorded this way. A
 * driving licence with no scan is a gap in the file; a NIN with no scan is
 * simply what a NIN is.
 */
export async function recordDriverReference(
  tenantId: string,
  driverId: string,
  input: RecordReferenceInput,
  actor: string | null,
): Promise<{ id: string }> {
  if (!isDocumentKind(input.kind)) {
    throw new Error(`"${input.kind}" is not a document this region uses.`);
  }
  if (!allowsReferenceOnly(input.kind)) {
    throw new Error(`A ${documentLabel(input.kind).toLowerCase()} needs the document itself, not just a number.`);
  }
  const reference = input.reference?.trim();
  if (!reference) throw new Error('Enter the number to record.');

  const sb = createServiceClient();
  // Tenant-scope the driver lookup: the service client bypasses RLS, so this
  // filter is the only thing stopping a record being attached to another
  // tenant's driver.
  const { data: driver } = await sb
    .from('drivers')
    .select('id')
    .eq('id', driverId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!driver) throw new Error('Driver not found in this organisation.');

  const inserted = await supersedeAndInsert(
    tenantId,
    driverId,
    { kind: input.kind, title: input.title, reference, issuedOn: input.issuedOn },
    null,
    actor,
  );

  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'driver_document.recorded',
    p_entity_type: 'driver',
    p_entity_id: driverId,
    p_detail: { kind: input.kind, reference } as never,
    p_actor: actor ?? undefined,
  });

  return inserted;
}

/**
 * Keep the legacy driver columns in step with the document just uploaded.
 *
 * This is what lets the whole existing compliance/blocking machinery carry on working
 * unchanged while the user gets one upload flow.
 *
 * Two guards, both because these columns gate whether a driver can be dispatched
 * (`BLOCKING_TYPES`):
 *
 *  - Only ever moves a date FORWARD. Uploading an old or expired licence for the record
 *    must not drag `pco_licence_expiry` backwards and re-raise a blocking obligation the
 *    driver has already cleared. Correcting a date downwards is deliberately not possible
 *    from an upload — that is an edit of the driver record.
 *  - Only called for trusted (ops) uploads; see `uploadDriverDocument`.
 */
async function applyWriteThrough(tenantId: string, driverId: string, input: UploadDocumentInput): Promise<void> {
  const sb = createServiceClient();
  const { data: current } = await sb
    .from('drivers')
    .select('pco_licence_expiry, dvla_checked_on')
    .eq('id', driverId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const existing = (current ?? {}) as { pco_licence_expiry: string | null; dvla_checked_on: string | null };

  const patch: Record<string, string> = {};

  if (input.kind === 'pco_licence') {
    if (advancesDate(input.expiresOn, existing.pco_licence_expiry)) {
      patch.pco_licence_expiry = input.expiresOn as string;
    }
    if (input.reference?.trim()) patch.pco_licence_no = input.reference.trim();
  }
  if (input.kind === 'dvla_check') {
    const checkedOn = input.issuedOn || new Date().toISOString().slice(0, 10);
    if (advancesDate(checkedOn, existing.dvla_checked_on)) patch.dvla_checked_on = checkedOn;
  }

  if (Object.keys(patch).length === 0) return;
  await sb.from('drivers').update(patch as never).eq('id', driverId).eq('tenant_id', tenantId);
}

export async function listDriverDocuments(
  tenantId: string,
  driverId: string,
  opts: { includeSuperseded?: boolean } = {},
): Promise<DriverDocument[]> {
  const sb = createServiceClient();
  let q = sb
    .from('driver_documents')
    .select('id, driver_id, kind, title, doc_path, reference, issued_on, expires_on, status, created_at')
    .eq('tenant_id', tenantId)
    .eq('driver_id', driverId);
  if (!opts.includeSuperseded) q = q.eq('status', 'active');
  const { data } = await q.order('created_at', { ascending: false });
  return (data ?? []) as DriverDocument[];
}

/** Resolve a document to its stored path, having first proved it belongs to the tenant. */
export async function getDriverDocumentForTenant(
  tenantId: string,
  documentId: string,
): Promise<DriverDocument | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('driver_documents')
    .select('id, driver_id, kind, title, doc_path, reference, issued_on, expires_on, status, created_at')
    .eq('tenant_id', tenantId)
    .eq('id', documentId)
    .maybeSingle();
  return (data as DriverDocument | null) ?? null;
}

/** Documents with an expiry, for the compliance sweep. */
export async function listExpiringDocuments(
  tenantId: string,
): Promise<{ driver_id: string; kind: DocumentKind; title: string | null; expires_on: string }[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('driver_documents')
    .select('driver_id, kind, title, expires_on')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .not('expires_on', 'is', null);
  return (data ?? []) as { driver_id: string; kind: DocumentKind; title: string | null; expires_on: string }[];
}

export async function deleteDriverDocument(tenantId: string, documentId: string, actor: string | null): Promise<void> {
  const sb = createServiceClient();
  const doc = await getDriverDocumentForTenant(tenantId, documentId);
  if (!doc) throw new Error('Document not found in this organisation.');

  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'driver_document.deleted',
    p_entity_type: 'driver',
    p_entity_id: doc.driver_id,
    p_detail: { kind: doc.kind, doc_path: doc.doc_path } as never,
    p_actor: actor ?? undefined,
  });

  const { error } = await sb.from('driver_documents').delete().eq('id', documentId).eq('tenant_id', tenantId);
  if (error) throw new Error(`Could not delete the document: ${error.message}`);
}
