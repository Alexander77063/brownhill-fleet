import { type NextRequest, NextResponse } from 'next/server';
import {
  type GoCardlessEvent,
  processGoCardlessEvents,
  verifyGoCardlessSignature,
} from '@/lib/payments/gocardless';
import { getTenantPaymentStatus, resolveTenantSecret } from '@/lib/payments/tenant-credentials';

// Node runtime: raw body needed for HMAC verification + node:crypto. Verify
// before parsing — re-serialising the JSON would break the signature.
export const runtime = 'nodejs';

// Per-tenant GoCardless webhook. Each tenant points THIS URL
// (/api/webhooks/gocardless/<tenantId>) at their own GoCardless webhook endpoint,
// and posts are verified with THAT tenant's webhook secret. No platform-key
// fallback: if the tenant hasn't stored a webhook secret we reject (fail closed).
export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const rawBody = await req.text();

  const secret = await resolveTenantSecret(tenantId, 'gocardless_webhook');
  if (!secret) {
    // Fail closed: tenant has no webhook secret configured.
    return NextResponse.json({ error: 'webhook not configured' }, { status: 400 });
  }

  const signature = req.headers.get('webhook-signature');
  if (!verifyGoCardlessSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let events: GoCardlessEvent[];
  try {
    const parsed = JSON.parse(rawBody) as { events?: GoCardlessEvent[] };
    events = parsed.events ?? [];
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // Fetching payment details needs the tenant's own API token (fail closed).
  const token = await resolveTenantSecret(tenantId, 'gocardless_token');
  if (!token) {
    return NextResponse.json({ error: 'gocardless not configured' }, { status: 400 });
  }
  const { gocardlessEnvironment } = await getTenantPaymentStatus(tenantId);

  try {
    await processGoCardlessEvents(events, token, gocardlessEnvironment, tenantId);
  } catch (err) {
    // Return 5xx so GoCardless retries; ingestion is idempotent.
    console.error('[gocardless webhook] processing error', err);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
