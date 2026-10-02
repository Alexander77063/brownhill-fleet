import type { NextRequest } from 'next/server';
import { handleGatewayWebhook } from '@/lib/collection/webhook';

// Platform Paystack webhook for subscription invoices (optional per instance —
// Paystack allows one webhook URL per account). Signature, then the gateway's
// verify endpoint, then the replay ledger, then confirmPayment.
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return handleGatewayWebhook('paystack', req);
}
