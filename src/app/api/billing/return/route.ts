import { NextResponse, type NextRequest } from 'next/server';
import { collectorBySource } from '@/lib/collection/collector';
import { confirmPayment, invoiceByToken } from '@/lib/collection/invoices';
import { looksLikePayToken } from '@/lib/collection/pay-token';

/**
 * Where the gateway sends the customer back. We put `src` and the pay token in
 * the return URL ourselves; Paystack appends `reference`/`trxref`, Flutterwave
 * appends `tx_ref`/`status`. Nothing here trusts the query string: the
 * reference is verified with the gateway and matched to the invoice before a
 * kobo is credited. Either way the customer lands on their invoice page, which
 * says paid or still pending.
 */
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const token = looksLikePayToken(q.get('t')) ? q.get('t') : null;
  const src = q.get('src') ?? '';
  const reference = q.get('reference') ?? q.get('trxref') ?? q.get('tx_ref') ?? q.get('ref');
  const to = (suffix: string) => NextResponse.redirect(new URL(token ? `/pay/${token}${suffix}` : '/login', req.url), { status: 303 });

  const invoice = await invoiceByToken(token);
  const collector = collectorBySource(src);
  if (!invoice || !collector || !reference) return to('?pending=1');
  if (invoice.status === 'paid') return to('?paid=1');

  const v = await collector.verify(reference);
  if (!v.ok) return to('?pending=1');
  if (v.invoiceId && v.invoiceId !== invoice.id) return to('?pending=1');

  try {
    await confirmPayment({
      source: collector.source,
      reference,
      amountMinor: v.amountMinor,
      currency: v.currency,
      externalRef: v.externalRef,
      raw: v.raw,
      actor: 'gateway',
      invoiceId: invoice.id,
    });
  } catch (e) {
    console.error('[billing/return] confirm failed', e);
    return to('?pending=1');
  }
  return to('?paid=1');
}
