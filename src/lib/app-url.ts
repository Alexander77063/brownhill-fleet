/**
 * The absolute origin of THIS deployment.
 *
 * Why a helper rather than `process.env.NEXT_PUBLIC_APP_URL` at each call
 * site: the address of a deployment is a fact about the deployment, and it is
 * known in two ways — configured, or observable from the request that is
 * already in hand. A page that prints a command against the WRONG address
 * (the upstream's, or `localhost`) is worse than one that prints nothing,
 * because the operator runs it and it fails.
 *
 * `NEXT_PUBLIC_APP_URL` first, because behind a proxy the request's own host
 * is not what the customer types into their browser. The forwarded headers
 * second. Null when neither is available — the caller then says so rather
 * than inventing an address.
 */
import { headers } from 'next/headers';

export async function appUrl(): Promise<string | null> {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '');
  if (configured) return configured;

  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) return null;
  return `${proto}://${host}`;
}
