/**
 * Receipt / evidence files — stored via the object-storage layer (Cloudflare R2
 * when configured, else Supabase Storage) and served as short-lived signed URLs.
 *
 * A receipt always attaches to a tenant-scoped record (an expense or a charge).
 * A signed URL is only ever minted for a `doc_path` that was resolved FROM such a
 * record (see /api/receipts) — never from a client-supplied path. That DB-row
 * check is the real access guard, so the storage backend can be swapped freely.
 */
import { storagePut, storageSignedUrl } from '@/lib/storage';

export const RECEIPTS_BUCKET = 'receipts';

/** True when a form value is a non-empty uploaded file. */
export function isUploadedFile(v: unknown): v is File {
  return v instanceof File && v.size > 0;
}

/**
 * Upload a receipt/evidence file to `receipts/<folder>/<ts>_<name>`. Returns the
 * stored path, or `null` with a human warning on failure — callers then persist a
 * null `doc_path` and carry on.
 */
export async function uploadReceipt(
  file: File,
  folder: string,
): Promise<{ path: string | null; warning?: string }> {
  const safeName = file.name.replace(/[^\w.\-]+/g, '_') || 'receipt';
  const path = `${folder}/${Date.now()}_${safeName}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { ok } = await storagePut(RECEIPTS_BUCKET, path, bytes, file.type || 'application/octet-stream');
  if (!ok) {
    return { path: null, warning: 'The file could not be stored — the record was saved without it.' };
  }
  return { path };
}

/**
 * Mint a short-lived signed URL for a receipt path. The caller MUST have already
 * authorised the path against a tenant-scoped record before calling this.
 */
export async function signReceiptUrl(docPath: string, expiresInSeconds = 120): Promise<string | null> {
  return storageSignedUrl(RECEIPTS_BUCKET, docPath, expiresInSeconds);
}
