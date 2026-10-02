/**
 * Which tenants are NOT being served right now (unpaid, suspended, cancelled).
 * Used by the sweeps — device health, monthly reports — to skip them in one
 * paged query rather than a status lookup per vehicle.
 */
import { pageAll } from '@/lib/page-all';
import { createServiceClient } from '@/lib/supabase/server';
import { SERVICEABLE } from './state';

type Sb = ReturnType<typeof createServiceClient>;

export async function blockedTenants(sb: Sb = createServiceClient()): Promise<Set<string>> {
  const rows = await pageAll<{ tenant_id: string }>((from, to) =>
    sb
      .from('tenant_subscription')
      .select('tenant_id')
      .not('status', 'in', `(${[...SERVICEABLE].join(',')})`)
      .order('tenant_id')
      .range(from, to),
  );
  return new Set(rows.map((r) => r.tenant_id));
}
