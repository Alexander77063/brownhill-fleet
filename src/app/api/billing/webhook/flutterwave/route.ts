import type { NextRequest } from 'next/server';
import { handleGatewayWebhook } from '@/lib/collection/webhook';

// Platform Flutterwave webhook for subscription invoices. The verif-hash is a
// shared secret, not a signature over the body, which is why the gateway's
// verify endpoint — not the body — is what credits an invoice.
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return handleGatewayWebhook('flutterwave', req);
}
