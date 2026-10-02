/**
 * Paystack, for subscriptions we collect (platform key). Lifted from PR #69's
 * tenant-BYO adapter: same hosted checkout, same HMAC-SHA512 webhook check,
 * plus `verify()` — the gateway's own answer, which is the only thing that
 * credits an invoice.
 *
 * Amounts: Paystack uses the currency's SUBUNIT (kobo), so our integer minor
 * units pass straight through. The opposite of Flutterwave.
 */
import crypto from 'node:crypto';
import { GATEWAY_TIMEOUT_MS, newReference, type CheckoutArgs, type CheckoutStart, type Env, type SubscriptionCollector, type VerifyFail, type VerifyOk } from './collector';

const PAYSTACK_API = 'https://api.paystack.co';

export interface PaystackEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * `x-paystack-signature` = HMAC-SHA512 of the raw body, keyed with the SECRET
 * KEY (Paystack has no separate webhook secret). Fail-closed on a missing
 * secret or header; constant-time compare after a length check.
 */
export function verifyPaystackSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function paystackCollector(env: Env = process.env): SubscriptionCollector {
  const key = env.PAYSTACK_SECRET_KEY ?? '';
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  return {
    source: 'paystack',
    configured: () => key.length > 0,

    async startCheckout(args: CheckoutArgs): Promise<CheckoutStart> {
      if (!key) throw new Error('Paystack is not configured on this instance.');
      // Fail closed rather than inventing an address: Paystack emails its receipt here.
      if (!args.payer.email) throw new Error('Paystack needs the payer’s email address to start a payment.');
      const reference = newReference(args.invoiceId);
      const res = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: args.payer.email,
          amount: args.amountMinor, // kobo: no conversion
          currency: args.currency,
          reference,
          callback_url: args.returnUrl,
          metadata: {
            invoice_id: args.invoiceId,
            invoice_number: args.invoiceNumber,
            custom_fields: [{ display_name: 'Invoice', variable_name: 'invoice', value: args.invoiceNumber }],
          },
        }),
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Paystack initialize failed (${res.status}): ${await res.text().catch(() => '')}`);
      const json = (await res.json()) as { status?: boolean; message?: string; data?: { authorization_url?: string } };
      // HTTP 200 with status:false is an application-level refusal.
      if (!json.status || !json.data?.authorization_url) throw new Error(`Paystack initialize refused: ${json.message ?? 'no authorization_url'}`);
      return { url: json.data.authorization_url, reference, source: 'paystack' };
    },

    async verify(reference: string): Promise<VerifyOk | VerifyFail> {
      if (!key) return { ok: false, reason: 'Paystack is not configured.' };
      const res = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: headers.Authorization },
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, reason: `Paystack verify failed (${res.status}).` };
      const json = (await res.json()) as {
        status?: boolean;
        message?: string;
        data?: { status?: string; amount?: number; currency?: string; id?: number | string; metadata?: { invoice_id?: string } };
      };
      if (!json.status || !json.data) return { ok: false, reason: json.message ?? 'Paystack returned no transaction.' };
      if (json.data.status !== 'success') return { ok: false, reason: `Paystack reports status "${json.data.status ?? 'unknown'}".` };
      return {
        ok: true,
        amountMinor: Number(json.data.amount ?? 0),
        currency: String(json.data.currency ?? ''),
        externalRef: String(json.data.id ?? reference),
        invoiceId: json.data.metadata?.invoice_id ? String(json.data.metadata.invoice_id) : undefined,
        raw: json.data,
      };
    },

    verifyWebhook(rawBody: string, hdrs: Headers) {
      if (!verifyPaystackSignature(rawBody, hdrs.get('x-paystack-signature'), key)) return { ok: false };
      try {
        const ev = JSON.parse(rawBody) as PaystackEvent;
        // Only a successful charge is money; failed charges and transfer events are acknowledged and ignored.
        if (ev.event !== 'charge.success' || (ev.data?.status && ev.data.status !== 'success')) return { ok: true };
        const reference = String(ev.data?.reference ?? '');
        return { ok: true, reference: reference || undefined };
      } catch {
        return { ok: false };
      }
    },
  };
}
