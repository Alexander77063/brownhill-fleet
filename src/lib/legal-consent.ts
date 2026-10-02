/** Server-side legal-acceptance checks + recording (service client, RLS-bypassing,
 *  explicitly tenant-scoped). Separate from lib/legal.ts so the pure constants stay
 *  importable by client components. */
import { createServiceClient } from '@/lib/supabase/server';
import { LEGAL_VERSION, LEGAL_DOCS } from '@/lib/legal';

/** True once this tenant has accepted the CURRENT legal version. FAIL-OPEN: if the
 *  query errors (e.g. the migration hasn't applied yet, or a transient DB issue) we
 *  return true so the consent gate never bricks the app — better to under-gate for a
 *  moment than lock every tenant out of /ops. */
export async function tenantAcceptedCurrentLegal(tenantId: string): Promise<boolean> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from('legal_acceptances')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('version', LEGAL_VERSION)
    .limit(1)
    .maybeSingle();
  if (error) return true;
  return !!data;
}

/** Record a tenant's acceptance of the current version (who + when, for audit). */
export async function recordLegalAcceptance(tenantId: string, userId: string, ip?: string | null): Promise<void> {
  const sb = createServiceClient();
  await sb.from('legal_acceptances').insert({
    tenant_id: tenantId,
    user_id: userId,
    version: LEGAL_VERSION,
    documents: LEGAL_DOCS.map((d) => d.slug),
    ip: ip ?? null,
  } as never);
}
