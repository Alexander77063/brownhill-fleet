/**
 * Object storage — Cloudflare R2 (S3-compatible) when configured, otherwise
 * Supabase Storage. A logical `bucket` name maps to an R2 key prefix or a Supabase
 * bucket, so stored `doc_path`s are identical across backends and no data model
 * changes. Dormant-safe: with no R2 env set, everything transparently uses Supabase
 * Storage (dev / CI), so nothing breaks until you point it at R2.
 *
 * R2 env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createServiceClient } from '@/lib/supabase/server';
import {
  localDelete,
  localGetBytes,
  localPut,
  localSignedUrl,
  localStorageConfigured,
} from '@/lib/storage/local';

/**
 * Every logical bucket this app stores things in.
 *
 * One list, for three jobs that must never disagree: the preflight round-trips each of these,
 * `tests/unit/storage-buckets.test.ts` asserts each has a migration creating it, and that same
 * test asserts nothing in `src/` writes to a bucket missing from here. A bucket used but not
 * listed is how `branding` came to be written to for months with nothing ever creating it.
 */
export const STORAGE_BUCKETS = [
  'branding',
  'driver-docs',
  // NG-3: installation photos, platform admins only.
  'hardware-jobs',
  'insurance-certs',
  'receipts',
] as const;

export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

/** True when Cloudflare R2 credentials are configured. */
export function r2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

/**
 * The R2 client configuration, exported so the checksum settings below can be asserted.
 *
 * They are the whole fix for "every upload fails in production", and two lines that look like
 * tuning are exactly the kind of thing a later cleanup deletes. A test pins them.
 */
export function r2ClientConfig(): S3ClientConfig {
  return {
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
    // R2 compatibility, and not optional at this SDK version.
    //
    // From @aws-sdk/client-s3 v3.729 the default became `WHEN_SUPPORTED`, which attaches an
    // `x-amz-checksum-crc32` header (and a trailing checksum on streamed bodies) to every
    // PutObject. R2 is S3-compatible but rejects those extra integrity headers — and it
    // rejects EVERY write, not an unlucky few, which is the exact shape of the failure this
    // addresses: driver documents and tenant logos both dead, while Supabase database calls
    // in the very same request stay perfectly healthy. This package sits at ^3.1094.0.
    //
    // This does NOT weaken integrity: the upload is still over TLS and still SigV4-signed,
    // which covers the payload. It only stops the SDK adding a checksum scheme the other end
    // never implemented.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

let client: S3Client | null = null;
function r2(): S3Client {
  if (!client) client = new S3Client(r2ClientConfig());
  return client;
}

const r2Key = (bucket: string, path: string) => `${bucket}/${path}`;

/**
 * Store bytes at `<bucket>/<path>`. `bucket` is a logical name ('receipts',
 * 'insurance-certs'); `path` is the key within it.
 *
 * Returns `ok`, plus `reason` — a short description of WHY it failed.
 *
 * ## Why `reason` exists
 *
 * This used to return a bare `{ ok: boolean }`, swallowing every failure including the
 * `catch`. An upload failing in production therefore surfaced as "Could not store the file.
 * Please try again." with nothing in the logs: the one thing needed to fix it — was the
 * bucket missing, were the credentials rejected, did the object already exist — was the one
 * thing thrown away. An error that cannot be diagnosed is worse than an error that is loud.
 *
 * `reason` is the backend's own message, which names the fault directly ("Bucket not found",
 * "InvalidAccessKeyId", "not implemented"). It carries no credentials — the SDKs report which
 * key was rejected, never its value — but it is still infrastructure detail, so callers decide
 * whether an end user sees it. It is logged server-side either way.
 */
export async function storagePut(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ ok: boolean; reason?: string }> {
  // Standalone build: the customer's own disk, no object store at all.
  if (localStorageConfigured()) return localPut(bucket, path, bytes, contentType);
  const backend = r2Configured() ? 'r2' : 'supabase';
  try {
    if (r2Configured()) {
      await r2().send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET as string,
          Key: r2Key(bucket, path),
          Body: bytes,
          ContentType: contentType,
        }),
      );
      return { ok: true };
    }
    const sb = createServiceClient();
    const { error } = await sb.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
    if (error) return { ok: false, reason: storageFailure('put', backend, bucket, path, error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: storageFailure('put', backend, bucket, path, err) };
  }
}

/**
 * Log a storage failure and return its reason.
 *
 * Logged as well as returned: a caller that degrades gracefully (the logo uploader stores
 * nothing and carries on) would otherwise discard the only record that anything went wrong,
 * which is how a storage backend stays broken for every bucket without raising one alert.
 *
 * `op` matters because reads and writes fail differently and are fixed differently: a failing
 * PUT loses new data, a failing GET or SIGN means documents that were stored fine will not
 * open. Both used to be silent.
 */
function storageFailure(
  op: 'put' | 'sign' | 'get' | 'delete',
  backend: string,
  bucket: string,
  path: string,
  err: unknown,
): string {
  const reason =
    err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  console.error(`[storage] ${op} failed`, { backend, bucket, path, reason });
  return reason;
}

/**
 * A short-lived signed GET URL for a stored object (the caller must have already authorised
 * `path` against a tenant-scoped record).
 *
 * Returns null on failure, as before — every caller treats "no URL" as "document unavailable"
 * and that is the right user-facing behaviour. What changed is that the reason is no longer
 * thrown away: a document that was stored perfectly well but will not open is precisely the
 * kind of fault that gets reported as "the link is broken" and investigated for hours.
 */
export async function storageSignedUrl(bucket: string, path: string, expiresIn = 120): Promise<string | null> {
  if (localStorageConfigured()) return localSignedUrl(bucket, path, expiresIn);
  const backend = r2Configured() ? 'r2' : 'supabase';
  try {
    if (r2Configured()) {
      return await getSignedUrl(
        r2(),
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET as string, Key: r2Key(bucket, path) }),
        { expiresIn },
      );
    }
    const sb = createServiceClient();
    const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
    if (error) storageFailure('sign', backend, bucket, path, error);
    return data?.signedUrl ?? null;
  } catch (err) {
    storageFailure('sign', backend, bucket, path, err);
    return null;
  }
}

/**
 * Remove an object. Best-effort by design — the only caller is the preflight cleaning up its own
 * probe, and failing to delete 16 bytes is untidy, not a fault worth reporting as one.
 */
export async function storageDelete(bucket: string, path: string): Promise<void> {
  if (localStorageConfigured()) return localDelete(bucket, path);
  const backend = r2Configured() ? 'r2' : 'supabase';
  try {
    if (r2Configured()) {
      await r2().send(
        new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET as string, Key: r2Key(bucket, path) }),
      );
      return;
    }
    const sb = createServiceClient();
    const { error } = await sb.storage.from(bucket).remove([path]);
    if (error) storageFailure('delete', backend, bucket, path, error);
  } catch (err) {
    storageFailure('delete', backend, bucket, path, err);
  }
}

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

/** Read an object's raw bytes + content-type (null when absent). Used to serve a
 *  public asset (e.g. a tenant logo) through an app route with a stable URL, since
 *  the R2 bucket isn't public and signed URLs expire. */
export async function storageGetBytes(bucket: string, path: string): Promise<StoredObject | null> {
  if (localStorageConfigured()) return localGetBytes(bucket, path);
  const backend = r2Configured() ? 'r2' : 'supabase';
  try {
    if (r2Configured()) {
      const out = await r2().send(
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET as string, Key: r2Key(bucket, path) }),
      );
      if (!out.Body) return null;
      const bytes = await (out.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return { bytes, contentType: out.ContentType ?? 'application/octet-stream' };
    }
    const sb = createServiceClient();
    const { data, error } = await sb.storage.from(bucket).download(path);
    if (error) storageFailure('get', backend, bucket, path, error);
    if (!data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    return { bytes, contentType: data.type || 'application/octet-stream' };
  } catch (err) {
    storageFailure('get', backend, bucket, path, err);
    return null;
  }
}
