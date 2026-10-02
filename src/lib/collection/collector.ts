/**
 * The SubscriptionCollector seam: how a tenant pays US.
 *
 * Platform credentials (env), the reverse of the tenant-BYO rent path in
 * src/lib/payments — 0037's money boundary read the other way round: these keys
 * are for subscriptions only. Nothing is credited from a redirect or a webhook
 * body; `verify()` asks the gateway and the caller matches amount and currency
 * against the invoice. Selection follows the region pack's provider order,
 * overridden by the console's preferred gateway, restricted to what is
 * configured on this instance.
 */
import crypto from 'node:crypto';
import { regionProvider, type RegionProvider } from '@/lib/region';
import { flutterwaveCollector } from './flutterwave';
import { paystackCollector } from './paystack';
import type { GatewayId } from './settings-defaults';

/** The environment a collector reads its keys from — process.env or a test map. */
export type Env = Record<string, string | undefined>;

export interface CheckoutStart {
  url: string;
  reference: string;
  source: GatewayId;
}

export interface VerifyOk {
  ok: true;
  amountMinor: number;
  currency: string;
  externalRef: string;
  /** The invoice id we put in the gateway metadata, when the gateway echoes it. */
  invoiceId?: string;
  raw: unknown;
}

export interface VerifyFail {
  ok: false;
  reason: string;
}

export interface CheckoutArgs {
  invoiceId: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  payer: { email: string; name?: string | null; phone?: string | null };
  returnUrl: string;
  description: string;
}

export interface SubscriptionCollector {
  readonly source: GatewayId;
  configured(): boolean;
  startCheckout(args: CheckoutArgs): Promise<CheckoutStart>;
  verify(reference: string): Promise<VerifyOk | VerifyFail>;
  /** ok=false: bad signature. ok=true without a reference: a legitimate event we do not act on. */
  verifyWebhook(rawBody: string, headers: Headers): { ok: boolean; reference?: string };
}

export const GATEWAY_TIMEOUT_MS = 8_000;

/** A reference unique per attempt, keyed to the invoice so a dashboard can be reconciled by eye. */
export function newReference(invoiceId: string): string {
  return `sub_${invoiceId.replace(/-/g, '').slice(0, 8)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

const FACTORIES: Record<GatewayId, (env: Env) => SubscriptionCollector> = {
  paystack: paystackCollector,
  flutterwave: flutterwaveCollector,
};

function isGateway(p: string): p is GatewayId {
  return p in FACTORIES;
}

/** The collector this instance should use, or null when none is configured (or the market has none, e.g. the UK Stripe path). */
export function collectorFor(opts: { region?: RegionProvider; preferred?: GatewayId | null; env?: Env } = {}): SubscriptionCollector | null {
  const region = opts.region ?? regionProvider();
  const env = opts.env ?? process.env;
  const order = region.paymentProviders.filter(isGateway);
  const ranked = opts.preferred && order.includes(opts.preferred) ? [opts.preferred, ...order.filter((p) => p !== opts.preferred)] : order;
  for (const id of ranked) {
    const c = FACTORIES[id](env);
    if (c.configured()) return c;
  }
  return null;
}

/** A specific gateway, for the return URL and webhooks (which name their source). */
export function collectorBySource(source: string, env: Env = process.env): SubscriptionCollector | null {
  return isGateway(source) ? FACTORIES[source](env) : null;
}

/** Which gateways are configured — for the settings page's readiness panel. */
export function configuredGateways(env: Env = process.env): GatewayId[] {
  return (Object.keys(FACTORIES) as GatewayId[]).filter((id) => FACTORIES[id](env).configured());
}
