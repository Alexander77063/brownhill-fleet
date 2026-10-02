import { NextResponse, type NextRequest } from 'next/server';
import { startCheckoutForToken } from '@/lib/collection/checkout';
import { looksLikePayToken } from '@/lib/collection/pay-token';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** "Pay now" on the public pay page: start the hosted checkout for exactly this invoice. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!looksLikePayToken(token)) return new NextResponse('Not found', { status: 404 });
  const fd = await req.formData();
  const back = (q: string) => NextResponse.redirect(new URL(`/pay/${token}?${q}`, req.url), { status: 303 });
  const returnBase = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  try {
    const r = await startCheckoutForToken(token, String(fd.get('email') ?? '') || null, returnBase);
    if (r.kind === 'redirect') return NextResponse.redirect(r.url, { status: 303 });
    if (r.kind === 'no_gateway') return back('nogateway=1');
    return back('paid=1');
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Payment could not be started.';
    return back(`error=${encodeURIComponent(message)}`);
  }
}
