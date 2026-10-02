/**
 * Serve a charge evidence file (image/video) by its media id — resolving the
 * `doc_path` only from a row scoped to the caller's tenant, then signing it. No
 * client-supplied path is ever signed (same guard as /api/receipts).
 */
import { NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { createServiceClient } from '@/lib/supabase/server';
import { signReceiptUrl } from '@/lib/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) return new NextResponse('Unauthorised', { status: 401 });

  const sb = createServiceClient();
  const { data } = await sb
    .from('charge_media')
    .select('doc_path')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  const docPath = (data as { doc_path: string } | null)?.doc_path;
  if (!docPath) return new NextResponse('Not found', { status: 404 });

  const url = await signReceiptUrl(docPath);
  if (!url) return new NextResponse('Not found', { status: 404 });
  return NextResponse.redirect(url);
}
