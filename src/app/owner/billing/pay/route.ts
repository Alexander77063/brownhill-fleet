import { NextResponse, type NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAuthContext } from '@/lib/auth/context';
import { startOwnerCheckout } from '@/lib/collection/checkout';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * The owner pressed Pay (an invoice) or Continue (a plan). Issues what needs
 * issuing, starts the hosted checkout and sends them there; any problem lands
 * back on the billing page with the reason.
 */
export async function POST(req: NextRequest) {
  const p = await requireRole(['owner']);
  const ctx = await getAuthContext();
  const back = (q: string) => NextResponse.redirect(new URL(`/owner/billing?${q}`, req.url), { status: 303 });
  if (!ctx?.tenantId || !p.vehicleOwnerId) return back('error=No%20owner%20record%20is%20linked%20to%20this%20account.');
  const fd = await req.formData();
  const returnBase = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  try {
    const r = await startOwnerCheckout({
      tenantId: ctx.tenantId,
      ownerId: p.vehicleOwnerId,
      invoiceId: String(fd.get('invoice_id') ?? '') || null,
      planId: String(fd.get('plan_id') ?? '') || null,
      email: String(fd.get('email') ?? '') || null,
      returnBase,
      actor: ctx.userId,
    });
    switch (r.kind) {
      case 'redirect':
        return NextResponse.redirect(r.url, { status: 303 });
      case 'no_gateway':
        return NextResponse.redirect(new URL(`/pay/${r.payToken}?nogateway=1`, req.url), { status: 303 });
      case 'plan_at_renewal':
        return back('notice=plan-at-renewal');
      case 'nothing_due':
        return back('notice=nothing-due');
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Payment could not be started.';
    return back(`error=${encodeURIComponent(message)}`);
  }
}
