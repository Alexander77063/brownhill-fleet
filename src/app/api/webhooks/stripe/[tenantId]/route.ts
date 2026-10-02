import { type NextRequest, NextResponse } from 'next/server';
import { processStripeEvent, type StripeEvent, verifyStripeSignature } from '@/lib/payments/stripe';
import { resolveTenantSecret } from '@/lib/payments/tenant-credentials';

// Node runtime: we need the raw request body for HMAC signature verification
// and node:crypto. Never parse before verifying — re-serialising breaks the HMAC.
export const runtime = 'nodejs';

// Per-tenant Stripe webhook. Each tenant configures THIS URL
// (/api/webhooks/stripe/<tenantId>) in their own Stripe dashboard, and posts are
// verified with THAT tenant's webhook secret. There is NO platform-key fallback:
// if the tenant hasn't stored a webhook secret we reject (fail closed). This is
// how a tenant's own rent/charge collection is ingested — the platform Stripe key
// is reserved for SaaS subscriptions and never touched here.
export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const rawBody = await req.text();

  const secret = await resolveTenantSecret(tenantId, 'stripe_webhook');
  if (!secret) {
    // Fail closed: tenant has no webhook secret configured.
    return NextResponse.json({ error: 'webhook not configured' }, { status: 400 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  try {
    await processStripeEvent(event, tenantId);
  } catch (err) {
    // Log and return 500 so Stripe retries; ingestion is idempotent so retries
    // are safe.
    console.error('[stripe webhook] processing error', err);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
