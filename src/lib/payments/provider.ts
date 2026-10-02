/**
 * Payment provider abstraction. Each provider (Stripe, GoCardless) knows how to
 * start a hosted checkout / mandate setup flow and return a redirect URL. Money
 * coming *back* from a provider is funnelled through `ingestPayment` (see
 * ./ingest) so ingestion is uniform and idempotent regardless of provider.
 */

export interface CheckoutArgs {
  /** Agreement the money is for; used to auto-allocate against its invoices. */
  agreementId: string;
  /** Driver paying, when known. */
  driverId?: string;
  /** Amount to collect, integer pence. */
  amountPence: number;
  /** Human description shown on the hosted page. */
  description?: string;
  /** Where to send the user after success / cancel. */
  successUrl: string;
  cancelUrl?: string;
}

export interface CheckoutResult {
  url: string;
}

/**
 * Per-tenant credentials for an outbound collection flow. Resolved from the
 * tenant's own stored secrets (never the platform env) and passed into
 * `createCheckout` at call time — so collection ALWAYS uses the tenant's keys
 * and fails closed when they're unset.
 */
export interface ProviderCredentials {
  /** The tenant's provider API key / access token. */
  apiKey: string;
  /** GoCardless only: which base URL to hit. Ignored by providers that don't need it. */
  environment?: 'sandbox' | 'live';
}

export interface PaymentProvider {
  /** Stable identifier, also the `payment_source` enum value used at ingest. */
  readonly name: 'stripe' | 'gocardless';
  /** Create a hosted checkout / mandate flow and return the redirect URL. */
  createCheckout(args: CheckoutArgs, creds: ProviderCredentials): Promise<CheckoutResult>;
}
