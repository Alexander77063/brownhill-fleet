/**
 * Serve a receipt image by record, not by path.
 *
 * The only way to mint a receipt URL: resolve the `doc_path` from an expense or
 * charge row scoped to the caller's own tenant, then sign it. A client-supplied
 * path is never signed, so an operator cannot read another tenant's receipt even
 * though the bucket's `is_ops()` policy is not tenant-scoped.
 */
import { NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/context';
import { createServiceClient } from '@/lib/supabase/server';
import { signReceiptUrl } from '@/lib/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TABLES = { expense: 'expenses', charge: 'charges' } as const;
type ReceiptKind = keyof typeof TABLES;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await params;
  if (!(kind in TABLES)) return new NextResponse('Not found', { status: 404 });
  const table = TABLES[kind as ReceiptKind];

  const ctx = await getAuthContext();
  if (!ctx?.tenantId) return new NextResponse('Unauthorised', { status: 401 });

  // Resolve the receipt path ONLY from a row in the caller's own tenant.
  const sb = createServiceClient();
  const { data } = await sb
    .from(table)
    .select('doc_path')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  const docPath = (data as { doc_path: string | null } | null)?.doc_path;
  if (!docPath) return new NextResponse('Not found', { status: 404 });

  const url = await signReceiptUrl(docPath);
  if (!url) return new NextResponse('Not found', { status: 404 });
  return NextResponse.redirect(url);
}
