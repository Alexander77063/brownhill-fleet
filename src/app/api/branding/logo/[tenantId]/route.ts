import { type NextRequest, NextResponse } from 'next/server';
import { storageGetBytes } from '@/lib/storage';

// Public: a tenant's logo is non-sensitive and must render everywhere (portal,
// emails, generated contracts) from a stable URL. Keyed by tenant id (a uuid, not
// a secret). Served from storage since the R2 bucket isn't public.
export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const obj = await storageGetBytes('branding', `${tenantId}/logo`);
  if (!obj) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new NextResponse(Buffer.from(obj.bytes), {
    status: 200,
    headers: {
      'content-type': obj.contentType,
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}
