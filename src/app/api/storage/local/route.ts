/**
 * Streams an object from the local-disk storage backend.
 *
 * The other backends presign against an object store; there is no object store
 * in a standalone install, so the app serves the bytes itself and the HMAC in
 * the query string is what authorises the read. The signature covers bucket,
 * path and expiry together, so a caller cannot lengthen the expiry or swap the
 * path for one they were never given.
 *
 * Every rejection is a 404, never a 403 or a descriptive error: a signed URL is
 * a bearer credential, and distinguishing "wrong signature" from "no such file"
 * would let a caller probe for which documents exist.
 *
 * ## Why the content type is not served as stored
 *
 * R2 and Supabase Storage serve documents from a DIFFERENT origin to the app.
 * This route, by construction, serves them from the SAME origin — so a stored
 * content type is attacker-controlled markup running in the operator's session.
 * A driver uploads `licence.html`, an admin opens it from the documents list,
 * and it executes with their cookies. `X-Content-Type-Options: nosniff` does
 * not help: it stops a browser guessing a type, not honouring one we declared.
 *
 * So only raster images render inline. Everything else — HTML, SVG (which
 * carries script), XML, PDF — is forced to `application/octet-stream` and sent
 * as an attachment, and every response carries a sandbox CSP as a second layer.
 * The tenant logo still displays; a malicious document downloads instead of
 * running.
 */
import { NextResponse } from 'next/server';
import { localGetBytes, localStorageConfigured, verifyLocalSignature } from '@/lib/storage/local';

export const runtime = 'nodejs';

/**
 * Content types safe to render inline, because a browser cannot be induced to
 * execute script from them. Deliberately raster-only: `image/svg+xml` is an XML
 * document that can carry `<script>`, and is the classic bypass for an
 * "images are safe" allow-list.
 */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

const notFound = () => new NextResponse('Not found', { status: 404 });

/** The basename of a stored path, sanitised for a Content-Disposition header. */
function downloadName(path: string): string {
  const base = path.split('/').pop() ?? 'download';
  // Strip quotes, control characters and anything that could break out of the
  // quoted-string form of the header.
  return base.replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'download';
}

export async function GET(request: Request) {
  // On a hosted deployment this route has no business serving anything: objects
  // live in R2 or Supabase Storage and are presigned there.
  if (!localStorageConfigured()) return notFound();

  const url = new URL(request.url);
  const bucket = url.searchParams.get('bucket');
  const path = url.searchParams.get('path');
  const sig = url.searchParams.get('sig');
  const exp = Number(url.searchParams.get('exp'));

  if (!bucket || !path || !sig) return notFound();
  if (!verifyLocalSignature(bucket, path, exp, sig)) return notFound();

  const obj = await localGetBytes(bucket, path);
  if (!obj) return notFound();

  const stored = obj.contentType.split(';')[0].trim().toLowerCase();
  const inline = INLINE_SAFE.has(stored);

  return new NextResponse(Buffer.from(obj.bytes) as unknown as BodyInit, {
    headers: {
      'content-type': inline ? stored : 'application/octet-stream',
      'content-disposition': inline
        ? 'inline'
        : `attachment; filename="${downloadName(path)}"`,
      // Private and short-lived: the URL itself is the credential.
      'cache-control': 'private, max-age=60',
      // Stop a browser guessing a type we did not declare.
      'x-content-type-options': 'nosniff',
      // Second layer: even if something slipped through the allow-list, a
      // sandboxed response has no origin and cannot run script or submit forms.
      'content-security-policy': "sandbox; default-src 'none'",
    },
  });
}
