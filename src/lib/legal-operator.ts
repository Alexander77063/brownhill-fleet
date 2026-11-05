/**
 * WHO OPERATES THE SERVICE, for the legal pages.
 *
 * Server-side, because the answer can come from the database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The legal pages used to name a hardcoded operator — one company's name,
 * one company's address, one company's email — on EVERY deployment. On a box
 * the customer operates, that made the privacy policy name a stranger, and
 * the terms of service name a company the customer is not. The registration
 * number and the registered office were literal bracketed placeholders, so
 * the document read:
 *
 *     "a company registered in England and Wales (company number
 *      [company registration number]), registered office
 *      [registered office address]"
 *
 * A document with a placeholder in it is a template that escaped. It shipped.
 *
 * THE RULE
 * --------
 * The operator is whoever operates THIS deployment:
 *
 *   * `customerOps` (the `standalone` and `hosted` profiles) — the customer
 *     operates their own box, so the operator is the customer, and the
 *     customer's identity is the branding they already enter in
 *     Settings → Branding. That is the same source the contract route
 *     already gates on, so the two cannot disagree about who the operator is.
 *
 *   * every other profile (`saas`, `managed`, `managed-shared`) — the platform
 *     operates, so the operator is the platform, configured by environment.
 *
 * A legal page never prints a placeholder and never prints a value the
 * operator has not set: `src/lib/legal.ts` holds the shape, and the pages
 * omit the clause when the value is missing.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { getBranding, type TenantBranding } from '@/lib/branding';
import { deploymentProfile } from '@/lib/deployment/profile';
import { deploymentBrand } from '@/lib/deployment/brand';
import { regionProvider } from '@/lib/region';
import { PLATFORM_OPERATOR, type OperatorIdentity } from '@/lib/legal';

/**
 * The branding of the install.
 *
 * A legal page is PUBLIC: a visitor with no session must be able to read the
 * privacy policy. `getBranding()` with no argument needs a signed-in tenant,
 * so on a box with no session we read the ONE tenant this deployment has —
 * a customer-operated box has exactly one, by definition.
 */
async function brandingOfThisInstall(): Promise<TenantBranding> {
  try {
    return await getBranding();
  } catch {
    // No session. Fall through to the single tenant below.
  }

  try {
    const sb = createServiceClient();
    const { data } = await sb
      .from('tenants')
      .select('id')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (!id) return {};
    return await getBranding(id);
  } catch {
    // No service client, or the database is unreachable. A legal page must
    // still render: it falls back to the product name and omits the clauses
    // it cannot fill in. A page that 500s because a database is down is worse
    // than a page that says less.
    return {};
  }
}

/**
 * The operator of this deployment.
 *
 * Never throws and never returns a placeholder: an unreachable database
 * yields an operator with fewer details, not a broken page.
 */
export async function resolveOperator(): Promise<OperatorIdentity> {
  const product = deploymentBrand().productName;
  const jurisdiction = regionProvider().legalJurisdiction;

  if (deploymentProfile().customerOps) {
    const b = await brandingOfThisInstall();
    return {
      entity: b.legal_name || b.trading_name || product,
      product,
      jurisdiction,
      companyNumber: b.company_number ?? '',
      registeredAddress: b.address ?? '',
      contactEmail: b.email ?? '',
      privacyEmail: b.email ?? '',
      website: '',
    };
  }

  return {
    entity: PLATFORM_OPERATOR.entity || product,
    product: PLATFORM_OPERATOR.product || product,
    jurisdiction: PLATFORM_OPERATOR.jurisdiction || jurisdiction,
    companyNumber: PLATFORM_OPERATOR.companyNumber,
    registeredAddress: PLATFORM_OPERATOR.registeredAddress,
    contactEmail: PLATFORM_OPERATOR.contactEmail,
    privacyEmail: PLATFORM_OPERATOR.privacyEmail || PLATFORM_OPERATOR.contactEmail,
    website: PLATFORM_OPERATOR.website,
  };
}
