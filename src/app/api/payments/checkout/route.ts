import { type NextRequest, NextResponse } from 'next/server';
import { gocardlessProvider } from '@/lib/payments/gocardless';
import type { PaymentProvider } from '@/lib/payments/provider';
import { stripeProvider } from '@/lib/payments/stripe';
import { getTenantPaymentStatus, resolveTenantSecret } from '@/lib/payments/tenant-credentials';
import { createClient } from '@/lib/supabase/server';
import { operatorName } from '@/lib/branding';
import { requireEntitlement } from '@/lib/entitlements';

// User-context route: createClient applies RLS so a driver can only start a
// checkout for an agreement they're allowed to see.
export const runtime = 'nodejs';

const PROVIDERS: Record<string, PaymentProvider> = {
  stripe: stripeProvider,
  gocardless: gocardlessProvider,
};

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);
  const agreementId = searchParams.get('agreement');
  const providerKey = (searchParams.get('provider') ?? 'stripe').toLowerCase();

  // The checkout is only ever started from the driver's own payments page, so
  // that is where the driver has to land afterwards — whether the payment
  // succeeded, was cancelled, or never started.
  //
  // These redirects used to point at `/billing`, which is not a route in this
  // application: there is no root `/billing` page, only `/driver/billing`,
  // `/ops/billing` and `/accounts/billing`. A driver whose payment SUCCEEDED
  // was dropped onto a 404 by the payment provider's redirect.
  const back = (error: string) =>
    NextResponse.redirect(new URL(`/driver/payments?error=${encodeURIComponent(error)}`, origin));

  // Driver-rent collection is the rental module. A tenant without it — every
  // Nigerian tier, and a UK tenant that did not buy rental — has nothing to
  // collect here. Gated on the entitlement, not the region.
  try {
    await requireEntitlement('rental.core');
  } catch {
    return back('not_in_plan');
  }

  if (!agreementId) return back('missing_agreement');

  const provider = PROVIDERS[providerKey];
  if (!provider) return back('unknown_provider');

  const sb = await createClient();

  // Resolve the agreement (RLS-scoped) and its outstanding balance from the
  // per-invoice balance view.
  const { data: agreement } = await sb
    .from('agreements')
    .select('id, driver_id, tenant_id')
    .eq('id', agreementId)
    .maybeSingle();
  if (!agreement) return back('agreement_not_found');

  // The TENANT's own credentials — collection lands in THEIR account, never the
  // platform's. Fail closed if they haven't connected this provider.
  const tenantId = (agreement as { tenant_id?: string }).tenant_id;
  if (!tenantId) return back('agreement_not_found');
  const apiKey = await resolveTenantSecret(
    tenantId,
    providerKey === 'gocardless' ? 'gocardless_token' : 'stripe_secret',
  );
  if (!apiKey) return back('payment_not_set_up');
  const environment =
    providerKey === 'gocardless' ? (await getTenantPaymentStatus(tenantId)).gocardlessEnvironment : undefined;

  const { data: invoices } = await sb
    .from('v_invoice_balance')
    .select('balance_pence')
    .eq('agreement_id', agreementId)
    .gt('balance_pence', 0);

  const outstandingPence = (invoices ?? []).reduce(
    (sum: number, r: { balance_pence: number | null }) => sum + (r.balance_pence ?? 0),
    0,
  );
  if (outstandingPence <= 0) return back('nothing_outstanding');

  const successUrl = new URL(`/driver/payments?paid=1&agreement=${agreementId}`, origin).toString();
  const cancelUrl = new URL(`/driver/payments?cancelled=1&agreement=${agreementId}`, origin).toString();

  try {
    const { url } = await provider.createCheckout(
      {
        agreementId,
        driverId: (agreement as { driver_id?: string }).driver_id,
        amountPence: outstandingPence,
        // Shown on the hosted checkout and on the driver's bank statement, so
        // it must name the operator they are paying — not the software vendor,
        // whom they have no relationship with and would query the charge over.
        description: `${await operatorName()} — outstanding balance`,
        successUrl,
        cancelUrl,
      },
      { apiKey, environment },
    );
    return NextResponse.redirect(url);
  } catch (err) {
    console.error('[checkout] provider error', err);
    return back('checkout_failed');
  }
}
