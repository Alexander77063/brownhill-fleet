/**
 * GoCardless integration via the REST API (no SDK). Used to set up Direct Debit
 * mandates for drivers and to ingest confirmed Direct Debit payments.
 *
 * API version is pinned to 2015-07-06 (the "Pro" API), so we use the
 * Redirect Flows endpoint to onboard a mandate and return a hosted redirect URL.
 * The mandate -> payment lifecycle then comes back through the webhook, where a
 * `payments` resource transitioning to `confirmed`/`paid_out` is ingested.
 *
 * GoCardless represents money in the smallest currency unit (pence for GBP), so
 * `amount` maps straight onto our integer-pence model.
 */

import crypto from 'node:crypto';
import { ingestPayment } from '@/lib/payments/ingest';
import type {
  CheckoutArgs,
  CheckoutResult,
  PaymentProvider,
  ProviderCredentials,
} from '@/lib/payments/provider';

const GC_VERSION = '2015-07-06';

// Base URL from the TENANT's chosen environment (not process.env).
function gcBase(environment?: 'sandbox' | 'live'): string {
  return environment === 'sandbox'
    ? 'https://api-sandbox.gocardless.com'
    : 'https://api.gocardless.com';
}

// Headers built from the TENANT's own access token — never process.env.
function gcHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'GoCardless-Version': GC_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Create a Redirect Flow so a driver can authorise a Direct Debit mandate, and
 * return the hosted `redirect_url`. The `session_token` is required to later
 * complete the flow; we encode the agreement id into it so completion can be
 * correlated server-side.
 */
async function createRedirectFlow(args: CheckoutArgs, creds: ProviderCredentials): Promise<CheckoutResult> {
  const sessionToken = `agr_${args.agreementId}_${Date.now()}`;
  const res = await fetch(`${gcBase(creds.environment)}/redirect_flows`, {
    method: 'POST',
    headers: gcHeaders(creds.apiKey),
    body: JSON.stringify({
      redirect_flows: {
        // See stripe.ts: the provider does not name a brand; callers pass the
        // operator's name.
        description: args.description ?? 'Vehicle hire — Direct Debit mandate',
        session_token: sessionToken,
        success_redirect_url: args.successUrl,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GoCardless redirect_flows failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { redirect_flows?: { redirect_url?: string } };
  const url = json.redirect_flows?.redirect_url;
  if (!url) throw new Error('GoCardless redirect_flows: no redirect_url in response');
  return { url };
}

interface GcPayment {
  amount: number;
  currency: string;
  status: string;
  links?: Record<string, string>;
  metadata?: Record<string, string>;
}

/** Fetch a single payment to read its amount/metadata (webhook bodies omit them). */
async function getPayment(
  paymentId: string,
  apiKey: string,
  environment?: 'sandbox' | 'live',
): Promise<GcPayment | null> {
  const res = await fetch(`${gcBase(environment)}/payments/${paymentId}`, { headers: gcHeaders(apiKey) });
  if (!res.ok) return null;
  const json = (await res.json()) as { payments?: GcPayment };
  return json.payments ?? null;
}

export const gocardlessProvider: PaymentProvider = {
  name: 'gocardless',
  createCheckout: createRedirectFlow,
};

// ── Webhook ────────────────────────────────────────────────────────────────

export interface GoCardlessEvent {
  id: string;
  resource_type: string;
  action: string;
  links?: Record<string, string>;
  details?: Record<string, unknown>;
}

/**
 * Verify the `Webhook-Signature` header: HMAC-SHA256 (hex) of the raw request
 * body keyed with the tenant's own webhook secret.
 *
 * Fail-closed: an absent secret or signature REJECTS. (An earlier revision read
 * the secret from the environment and skipped verification when it was unset;
 * that dev bypass is gone. Locked in by tests/unit/webhook-signatures.test.ts.)
 */
export function verifyGoCardlessSignature(rawBody: string, signature: string | null, secret: string): boolean {
  // Verify against the tenant's own webhook secret. No secret ⇒ reject.
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Process a batch of GoCardless events. Only confirmed/paid-out payment events
 * move money; for each we fetch the payment (events carry links, not amounts)
 * and ingest idempotently keyed on the GC payment id.
 */
export async function processGoCardlessEvents(
  events: GoCardlessEvent[],
  apiKey: string,
  environment?: 'sandbox' | 'live',
  expectedTenantId?: string,
): Promise<void> {
  for (const event of events) {
    if (event.resource_type !== 'payments') continue;
    if (!['confirmed', 'paid_out'].includes(event.action)) continue;

    const paymentId = event.links?.payment;
    if (!paymentId) continue;

    const payment = await getPayment(paymentId, apiKey, environment);
    if (!payment) {
      console.warn(`[gocardless] could not fetch payment ${paymentId} — skipping`);
      continue;
    }

    // Correlate to an agreement via the GC payment's metadata (set when the
    // payment/subscription was created). GoCardless `links` carry only GC
    // resources (mandate, creditor...), never our domain ids. Without a match
    // the receipt is still recorded; it just isn't auto-allocated.
    const agreementId = payment.metadata?.agreement_id;

    await ingestPayment({
      source: 'gocardless',
      idempotencyKey: paymentId,
      amountPence: payment.amount, // GoCardless GBP amounts are already pence
      agreementId,
      expectedTenantId,
      externalRef: paymentId,
      raw: { event, payment },
    });
  }
}
