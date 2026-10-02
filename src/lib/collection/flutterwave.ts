/**
 * Flutterwave, for subscriptions we collect (platform key). Lifted from PR #69's
 * tenant-BYO adapter, plus `verify()`.
 *
 * ## Amounts — the one thing to get right here
 * Flutterwave takes and reports amounts in the MAJOR unit: `1500` means ₦1,500.
 * Our model is integer minor units, so this file is the only place an amount is
 * divided and multiplied. `toMajor` / `fromMajor` exist so the conversion has a
 * name and a test rather than an inline `/ 100`.
 *
 * ## Webhooks
 * Flutterwave does NOT sign the body. It sends back, verbatim, a "secret hash"
 * the operator sets in the dashboard, so `verif-hash` is a shared-secret
 * equality check — which is why `verify()` is what credits money, never the body.
 */
import crypto from 'node:crypto';
import { GATEWAY_TIMEOUT_MS, newReference, type CheckoutArgs, type CheckoutStart, type Env, type SubscriptionCollector, type VerifyFail, type VerifyOk } from './collector';

const FLUTTERWAVE_API = 'https://api.flutterwave.com/v3';

/** Integer minor units → the major-unit amount Flutterwave expects. */
export function toMajor(minor: number): number {
  return minor / 100;
}

/** A major-unit amount from Flutterwave → integer minor units, rounded so float JSON never loses a kobo. */
export function fromMajor(major: number): number {
  return Math.round(major * 100);
}

export interface FlutterwaveEvent {
  event?: string;
  data?: Record<string, unknown>;
}

export function verifyFlutterwaveSignature(header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(secret, 'utf8');
  const b = Buffer.from(header.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function flutterwaveCollector(env: Env = process.env): SubscriptionCollector {
  const key = env.FLUTTERWAVE_SECRET_KEY ?? '';
  const hash = env.FLUTTERWAVE_WEBHOOK_HASH ?? '';
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  return {
    source: 'flutterwave',
    configured: () => key.length > 0,

    async startCheckout(args: CheckoutArgs): Promise<CheckoutStart> {
      if (!key) throw new Error('Flutterwave is not configured on this instance.');
      if (!args.payer.email) throw new Error('Flutterwave needs the payer’s email address to start a payment.');
      const reference = newReference(args.invoiceId);
      const res = await fetch(`${FLUTTERWAVE_API}/payments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tx_ref: reference,
          amount: toMajor(args.amountMinor), // MAJOR units — the 100x line
          currency: args.currency,
          redirect_url: args.returnUrl,
          customer: { email: args.payer.email, name: args.payer.name ?? undefined, phonenumber: args.payer.phone ?? undefined },
          customizations: { title: args.description },
          meta: { invoice_id: args.invoiceId, invoice_number: args.invoiceNumber },
        }),
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Flutterwave payment link failed (${res.status}): ${await res.text().catch(() => '')}`);
      const json = (await res.json()) as { status?: string; message?: string; data?: { link?: string } };
      if (json.status !== 'success' || !json.data?.link) throw new Error(`Flutterwave refused the payment link: ${json.message ?? 'no link'}`);
      return { url: json.data.link, reference, source: 'flutterwave' };
    },

    async verify(reference: string): Promise<VerifyOk | VerifyFail> {
      if (!key) return { ok: false, reason: 'Flutterwave is not configured.' };
      const res = await fetch(`${FLUTTERWAVE_API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
        headers: { Authorization: headers.Authorization },
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, reason: `Flutterwave verify failed (${res.status}).` };
      const json = (await res.json()) as {
        status?: string;
        message?: string;
        data?: { status?: string; amount?: number; currency?: string; id?: number | string; meta?: { invoice_id?: string } };
      };
      if (json.status !== 'success' || !json.data) return { ok: false, reason: json.message ?? 'Flutterwave returned no transaction.' };
      if (String(json.data.status ?? '').toLowerCase() !== 'successful') return { ok: false, reason: `Flutterwave reports status "${json.data.status ?? 'unknown'}".` };
      return {
        ok: true,
        amountMinor: fromMajor(Number(json.data.amount ?? 0)),
        currency: String(json.data.currency ?? ''),
        externalRef: String(json.data.id ?? reference),
        invoiceId: json.data.meta?.invoice_id ? String(json.data.meta.invoice_id) : undefined,
        raw: json.data,
      };
    },

    verifyWebhook(rawBody: string, hdrs: Headers) {
      if (!verifyFlutterwaveSignature(hdrs.get('verif-hash'), hash)) return { ok: false };
      try {
        const ev = JSON.parse(rawBody) as FlutterwaveEvent;
        // charge.completed fires for FAILED charges too; the inner status decides.
        if (ev.event !== 'charge.completed' || String(ev.data?.status ?? '').toLowerCase() !== 'successful') return { ok: true };
        const reference = String(ev.data?.tx_ref ?? '');
        return { ok: true, reference: reference || undefined };
      } catch {
        return { ok: false };
      }
    },
  };
}
