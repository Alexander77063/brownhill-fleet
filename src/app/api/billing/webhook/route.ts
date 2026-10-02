import { type NextRequest, NextResponse } from 'next/server';
import { type StripeEvent, processBillingEvent, verifyStripeSignature } from '@/lib/billing';

// Node runtime: raw body for HMAC verification. Verify before parsing.
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');

  // Platform subscription webhook — verified with the PLATFORM's webhook secret.
  if (!verifyStripeSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET ?? '')) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  try {
    await processBillingEvent(event);
  } catch (err) {
    console.error('[billing webhook] processing error', err);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
