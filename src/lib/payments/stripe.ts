/**
 * Stripe integration via the REST API (no SDK). Used for one-off card payments
 * (deposits / ad-hoc balances) through hosted Checkout, and to ingest
 * successful payments via webhook.
 *
 * Stripe amounts are already in the smallest currency unit (pence for GBP), so
 * `amount_total` / `amount` map straight onto our integer-pence model.
 */

import crypto from 'node:crypto';
import { ingestPayment } from '@/lib/payments/ingest';
import type {
  CheckoutArgs,
  CheckoutResult,
  PaymentProvider,
  ProviderCredentials,
} from '@/lib/payments/provider';

const STRIPE_API = 'https://api.stripe.com/v1';

// Headers built from the TENANT's own secret key — never process.env.
function stripeHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/**
 * Create a one-off Checkout Session (mode=payment) for a GBP amount and return
 * its hosted `url`. Agreement/driver ids ride along in metadata so the webhook
 * can correlate the receipt back to the right agreement at ingest time.
 */
async function createCheckout(args: CheckoutArgs, creds: ProviderCredentials): Promise<CheckoutResult> {
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', args.successUrl);
  params.set('cancel_url', args.cancelUrl ?? args.successUrl);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'gbp');
  params.set('line_items[0][price_data][unit_amount]', String(args.amountPence));
  params.set(
    'line_items[0][price_data][product_data][name]',
    // A payment provider has no business knowing a brand name; callers pass the
    // operator's. This fallback is only reached if one forgets to.
    args.description ?? 'Vehicle hire payment',
  );
  params.set('metadata[agreement_id]', args.agreementId);
  if (args.driverId) params.set('metadata[driver_id]', args.driverId);
  // Propagate metadata onto the PaymentIntent so payment_intent.succeeded also
  // carries the correlation ids.
  params.set('payment_intent_data[metadata][agreement_id]', args.agreementId);
  if (args.driverId) params.set('payment_intent_data[metadata][driver_id]', args.driverId);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: stripeHeaders(creds.apiKey),
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe checkout session failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { url?: string };
  if (!json.url) throw new Error('Stripe checkout session: no url in response');
  return { url: json.url };
}

export const stripeProvider: PaymentProvider = {
  name: 'stripe',
  createCheckout,
};

// ── Webhook ────────────────────────────────────────────────────────────────

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Verify the `Stripe-Signature` header. The header is `t=<ts>,v1=<sig>,...`;
 * the signed payload is `${t}.${rawBody}` and the signature is HMAC-SHA256 hex
 * keyed with the caller-supplied secret — the platform secret for subscription
 * webhooks, the tenant's own secret for their collection webhooks.
 *
 * Fail-closed: an absent secret or header REJECTS. (An earlier revision read the
 * secret from the environment and skipped verification when it was unset; that
 * dev bypass is gone. Locked in by tests/unit/webhook-signatures.test.ts.)
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  // Verify against the CALLER-supplied secret (platform secret for subscriptions,
  // the tenant's own secret for their collection). No secret ⇒ reject.
  if (!secret || !header) return false;

  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  ) as Record<string, string>;

  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Ingest a successful Stripe payment event. Handles both
 * `checkout.session.completed` (amount_total) and `payment_intent.succeeded`
 * (amount). The idempotency key is the underlying PaymentIntent id when known
 * (stable across the two event types for one payment), else the event id.
 */
export async function processStripeEvent(event: StripeEvent, expectedTenantId?: string): Promise<void> {
  const obj = event.data.object;

  if (event.type === 'checkout.session.completed') {
    if (obj.payment_status && obj.payment_status !== 'paid') return;
    const amountPence = Number(obj.amount_total ?? 0);
    const paymentIntent = (obj.payment_intent as string | undefined) ?? event.id;
    const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
    await ingestPayment({
      source: 'stripe',
      idempotencyKey: paymentIntent,
      amountPence,
      agreementId: metadata.agreement_id,
      driverId: metadata.driver_id,
      externalRef: (obj.id as string) ?? event.id,
      expectedTenantId,
      raw: event,
    });
    return;
  }

  if (event.type === 'payment_intent.succeeded') {
    const amountPence = Number(obj.amount_received ?? obj.amount ?? 0);
    const paymentIntent = (obj.id as string | undefined) ?? event.id;
    const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
    await ingestPayment({
      source: 'stripe',
      idempotencyKey: paymentIntent,
      amountPence,
      agreementId: metadata.agreement_id,
      driverId: metadata.driver_id,
      externalRef: paymentIntent,
      expectedTenantId,
      raw: event,
    });
  }
}
