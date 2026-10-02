/**
 * One handler for both gateway webhooks. The body is a hint; the gateway's
 * verify endpoint is the truth. Order matters:
 *   1. signature   → 400 if bad
 *   2. verify      → 200 "unverified" if the gateway does not say paid (a later
 *                    retry verifies again; nothing is remembered)
 *   3. ledger      → billing_events(source:reference); a duplicate is a replay → 200
 *   4. confirm     → on our own failure, release the ledger row and 500 so the
 *                    gateway retries
 * Webhooks are optional per instance (Paystack allows one URL per account);
 * verify-on-return and the daily reconciliation do the same job without them.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { collectorBySource } from './collector';
import { confirmPayment } from './invoices';

export async function handleGatewayWebhook(source: 'paystack' | 'flutterwave', req: NextRequest): Promise<NextResponse> {
  const collector = collectorBySource(source);
  if (!collector || !collector.configured()) return new NextResponse('Not configured', { status: 404 });

  const raw = await req.text();
  const w = collector.verifyWebhook(raw, req.headers);
  if (!w.ok) return new NextResponse('Bad signature', { status: 400 });
  if (!w.reference) return NextResponse.json({ ok: true, ignored: true });

  const v = await collector.verify(w.reference);
  if (!v.ok) return NextResponse.json({ ok: true, unverified: v.reason });

  const sb = createServiceClient();
  const ledgerId = `${source}:${w.reference}`;
  const { error: ledgerErr } = await sb.from('billing_events').insert({ id: ledgerId, type: `${source}.charge`, tenant_id: null } as never);
  if (ledgerErr) {
    if (ledgerErr.code === '23505') return NextResponse.json({ ok: true, replay: true });
    return new NextResponse(`ledger: ${ledgerErr.message}`, { status: 500 });
  }

  try {
    const r = await confirmPayment({
      source,
      reference: w.reference,
      amountMinor: v.amountMinor,
      currency: v.currency,
      externalRef: v.externalRef,
      raw: v.raw,
      actor: 'webhook',
      sb,
    });
    return NextResponse.json({ ok: true, invoicePaid: r.invoicePaid, alreadyConfirmed: r.alreadyConfirmed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A reference we never started is not ours to retry; anything else is.
    if (/Unknown payment reference/.test(message)) return NextResponse.json({ ok: true, unknownReference: true });
    await sb.from('billing_events').delete().eq('id', ledgerId);
    return new NextResponse(message, { status: 500 });
  }
}
