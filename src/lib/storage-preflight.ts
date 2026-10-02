/**
 * Storage preflight — can this deployment actually store and retrieve bytes?
 *
 * ## Why this exists
 *
 * Uploads broke in production for every bucket and nobody knew until a user reported it. The
 * failure was invisible from the outside: the app was up, the database was healthy, pages
 * rendered, and CI was green — because CI runs against Supabase Storage while production runs
 * against Cloudflare R2. A backend that only exists in production is a backend no test covers.
 *
 * So this does the one thing that cannot be faked: a real round trip. It writes a few bytes,
 * reads them back, compares them, and deletes them — per bucket, against whichever backend this
 * deployment is actually configured for. It would have caught both faults behind that outage in
 * seconds: R2 rejecting every write, and the `branding` bucket that no migration created.
 *
 * Run it after a deploy, after rotating storage credentials, and after any migration that adds a
 * bucket.
 */
import { randomUUID } from 'node:crypto';
import { STORAGE_BUCKETS, storageGetBytes, storagePut, storageDelete, r2Configured } from '@/lib/storage';

/**
 * Remove the probe, never letting cleanup break the check.
 *
 * `storageDelete` already swallows its own failures, but relying on that would make this
 * function correct only by someone else's promise: the day it starts throwing, the preflight
 * would fail wholesale and report a storage outage that is not happening. A monitor that cries
 * wolf is worse than no monitor.
 */
async function discardProbe(bucket: string, path: string): Promise<void> {
  try {
    await storageDelete(bucket, path);
  } catch {
    /* untidy, not broken */
  }
}

export interface BucketCheck {
  bucket: string;
  ok: boolean;
  /** Which step failed, so the fix is obvious: credentials/bucket vs. read path vs. cleanup. */
  step?: 'write' | 'read' | 'verify';
  reason?: string;
}

export interface PreflightResult {
  ok: boolean;
  backend: 'r2' | 'supabase';
  buckets: BucketCheck[];
}

/**
 * Round-trip a probe object through every bucket the app uses.
 *
 * The probe lives under `__preflight/` and is deleted afterwards. A failed delete does NOT fail
 * the check — leaving a 16-byte object behind is untidy, not broken, and reporting it as a
 * failure would train people to ignore this endpoint.
 */
export async function storagePreflight(): Promise<PreflightResult> {
  const backend: 'r2' | 'supabase' = r2Configured() ? 'r2' : 'supabase';
  const buckets: BucketCheck[] = [];

  for (const bucket of STORAGE_BUCKETS) {
    const path = `__preflight/${randomUUID()}.txt`;
    const payload = new TextEncoder().encode(`preflight ${randomUUID()}`);

    const put = await storagePut(bucket, path, payload, 'text/plain');
    if (!put.ok) {
      buckets.push({ bucket, ok: false, step: 'write', reason: put.reason ?? 'unknown' });
      continue;
    }

    const got = await storageGetBytes(bucket, path);
    if (!got) {
      buckets.push({ bucket, ok: false, step: 'read', reason: 'stored, but could not be read back' });
      await discardProbe(bucket, path);
      continue;
    }

    // Compare the bytes, not just their presence: a backend that returns an empty body, or an
    // error page, or a stale object would otherwise pass a check that only asked "is it there?".
    const same =
      got.bytes.length === payload.length && got.bytes.every((b, i) => b === payload[i]);
    buckets.push(
      same
        ? { bucket, ok: true }
        : { bucket, ok: false, step: 'verify', reason: 'read back different bytes than were written' },
    );

    await discardProbe(bucket, path);
  }

  return { ok: buckets.every((b) => b.ok), backend, buckets };
}
