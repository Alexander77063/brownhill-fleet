/**
 * Local-disk storage backend, for the standalone build where there is no R2 and
 * no Supabase Storage — only the customer's own machine.
 *
 * The layout mirrors the logical bucket/path split the other backends use, so a
 * stored `doc_path` means the same thing on every backend and no data model
 * changes: `<root>/<bucket>/<path>`, with a sidecar `<path>.meta.json` holding
 * the content type, since a filesystem has no equivalent of object metadata.
 *
 * Selected by `LOCAL_STORAGE_ROOT` being set, which no hosted deployment sets —
 * so every existing environment keeps exactly the backend it has today.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deploymentProfile } from '@/lib/deployment/profile';
import type { StoredObject } from '@/lib/storage';

function root(): string {
  return process.env.LOCAL_STORAGE_ROOT ?? join(process.cwd(), '.local-storage');
}

/** True when this build stores objects on the local filesystem. */
export function localStorageConfigured(): boolean {
  return Boolean(process.env.LOCAL_STORAGE_ROOT);
}

/**
 * Resolve `<root>/<bucket>/<path>`, or null if the result escapes the bucket.
 *
 * `path` derives partly from user-supplied filenames, so traversal must never
 * reach the filesystem. Resolving first and then checking containment catches
 * encodings that a string-level '..' test misses.
 *
 * ## The absolute-path case, which is NOT covered by the '..' checks
 *
 * On Windows — the standalone build's only target — `relative()` between paths
 * on different roots returns an ABSOLUTE path, which begins with neither '..'
 * nor '..\'. Measured:
 *
 *   path 'D:\evil\x.txt'          -> rel 'D:\evil\x.txt'          (escapes)
 *   path '\\server\share\x.txt'   -> rel '\\server\share\x.txt'   (escapes)
 *   path '../../etc/passwd'       -> rel '..\..\etc\passwd'       (caught)
 *
 * So a drive letter or a UNC path walks straight out of the bucket, and the UNC
 * case is the worse of the two: it would put a write on a remote share.
 * `looksAbsolute` below is what closes that.
 */

/**
 * Absolute on ANY platform, not merely on the one this happens to be running on.
 *
 * `isAbsolute()` answers for its host. On Linux a backslash is an ordinary
 * filename character, so `D:\evil\x.txt` is a legal *relative* name and the
 * drive-letter and UNC shapes sail straight past it. That split is not
 * hypothetical — it is why these cases passed on a Windows machine and failed on
 * Linux CI.
 *
 * The standalone build targets Windows, but its guard runs wherever the tests
 * and the hosted build do, and a rule that means different things in different
 * places is not a rule. So the shapes are named explicitly instead of delegated
 * to the platform.
 */
function looksAbsolute(p: string): boolean {
  return (
    isAbsolute(p) || // whatever this host already considers absolute
    /^[A-Za-z]:/.test(p) || // drive-qualified: 'C:\...', and bare 'C:foo'
    /^[\\/]{2}/.test(p) || // UNC share: '\\server\share'
    p.startsWith('\\') // root of the current drive
  );
}

function safePath(bucket: string, path: string): string | null {
  // Checked on the way in as well as after resolving: on a host that does not
  // recognise the shape, `resolve()` treats it as an ordinary segment and the
  // result stays inside the bucket, so the check below would never fire.
  if (looksAbsolute(path)) return null;

  const base = resolve(root(), bucket);
  const full = resolve(base, path);
  const rel = relative(base, full);
  if (rel === '' || looksAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return full;
}

/**
 * The HMAC key for signed URLs.
 *
 * In a standalone install this signature is the ONLY authorisation on every
 * document read — there is no object store enforcing anything behind it. A
 * shared default key would therefore mean every install can mint valid URLs for
 * every other install's documents.
 *
 * So a customer-facing profile with no key configured throws, on exactly the
 * reasoning `deploymentProfile()` uses for an unknown profile name: shipping a
 * silently-insecure build is a worse outcome than failing loudly at the first
 * request. The development fallback survives only for `saas`, where this
 * backend is inactive and the route 404s regardless.
 */
function secret(): string {
  const configured = process.env.LOCAL_STORAGE_SIGNING_KEY;
  if (configured) return configured;

  const profile = deploymentProfile().id;
  if (profile !== 'saas') {
    throw new Error(
      `LOCAL_STORAGE_SIGNING_KEY must be set under the "${profile}" profile: it is the only ` +
        'authorisation on stored document reads. The installer generates one per install.',
    );
  }
  return 'dev-only-unsafe-key';
}

export async function localPut(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ ok: boolean; reason?: string }> {
  const full = safePath(bucket, path);
  if (!full) return { ok: false, reason: `Rejected path outside bucket: ${bucket}/${path}` };
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    writeFileSync(`${full}.meta.json`, JSON.stringify({ contentType }), 'utf8');
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[storage] local put failed', { bucket, path, reason });
    return { ok: false, reason };
  }
}

export async function localGetBytes(bucket: string, path: string): Promise<StoredObject | null> {
  const full = safePath(bucket, path);
  if (!full) return null;
  try {
    const bytes = new Uint8Array(readFileSync(full));
    let contentType = 'application/octet-stream';
    try {
      const meta = JSON.parse(readFileSync(`${full}.meta.json`, 'utf8')) as {
        contentType?: string;
      };
      contentType = meta.contentType ?? contentType;
    } catch {
      // No sidecar (file restored from a backup, or written by an older build).
      // The octet-stream default is correct rather than fatal.
    }
    return { bytes, contentType };
  } catch {
    return null;
  }
}

/**
 * A signed, expiring URL served by the app itself.
 *
 * There is no object store to presign against, so `/api/storage/local` verifies
 * this HMAC before streaming the bytes. The signature covers bucket, path AND
 * expiry together, so none of the three can be edited independently — swapping
 * the path or extending the expiry both invalidate it.
 */
export async function localSignedUrl(
  bucket: string,
  path: string,
  expiresIn = 120,
): Promise<string | null> {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = sign(bucket, path, exp);
  const q = new URLSearchParams({ bucket, path, exp: String(exp), sig });
  return `/api/storage/local?${q.toString()}`;
}

function sign(bucket: string, path: string, exp: number): string {
  // Newline-delimited so ('a','bc') and ('ab','c') cannot produce the same MAC.
  return createHmac('sha256', secret()).update(`${bucket}\n${path}\n${exp}`).digest('hex');
}

/** Verify a signature produced by `localSignedUrl`. Constant-time. */
export function verifyLocalSignature(
  bucket: string,
  path: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  if (!/^[0-9a-f]+$/i.test(sig)) return false;

  const expected = Buffer.from(sign(bucket, path, exp), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function localDelete(bucket: string, path: string): Promise<void> {
  const full = safePath(bucket, path);
  if (!full) return;
  rmSync(full, { force: true });
  rmSync(`${full}.meta.json`, { force: true });
}
