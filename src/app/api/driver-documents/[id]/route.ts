/**
 * Serve a driver document by its id.
 *
 * The stored path is resolved from a row scoped to the caller's tenant and then signed —
 * a client-supplied path is never signed (same guard as /api/receipts). A driver may only
 * fetch their own documents; ops may fetch any within their tenant.
 */
import { NextResponse } from 'next/server';
import { getSessionProfile } from '@/lib/auth';
import { getAuthContext } from '@/lib/auth/context';
import { DOCUMENT_BUCKET, getDriverDocumentForTenant } from '@/lib/driver-documents';
import { storageSignedUrl } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) return new NextResponse('Unauthorised', { status: 401 });

  const doc = await getDriverDocumentForTenant(ctx.tenantId, id);
  if (!doc) return new NextResponse('Not found', { status: 404 });

  // A driver is only ever allowed their own paperwork, even inside their own tenant.
  const profile = await getSessionProfile();
  if (profile?.role === 'driver' && profile.driverId !== doc.driver_id) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Reference-only records (a Nigerian NIN is a number, not a scan) have no
  // file to serve. 404 rather than signing a null path.
  if (!doc.doc_path) return new NextResponse('Not found', { status: 404 });

  const url = await storageSignedUrl(DOCUMENT_BUCKET, doc.doc_path);
  if (!url) return new NextResponse('Not found', { status: 404 });
  return NextResponse.redirect(url);
}
