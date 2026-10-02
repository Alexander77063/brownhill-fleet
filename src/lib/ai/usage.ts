/**
 * Platform-AI metering & budgets (hybrid AI). Tenants without their own provider
 * key run on the platform account; every completion's tokens are accumulated per
 * calendar month and checked against the tenant's plan budget
 * (plans.limits['ai.platform.tokens']). BYO-key tenants are billed by their own
 * provider and are never metered here.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { resolveEntitlementsForTenant, type FeatureKey } from '@/lib/entitlements';

const PLATFORM_FEATURE = 'ai.platform' as FeatureKey;
const BUDGET_LIMIT_KEY = 'ai.platform.tokens';

/** First day of the current month (UTC), as YYYY-MM-DD. */
export function currentPeriodMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Total platform-AI tokens (in + out) a tenant has used this month. */
export async function getMonthlyPlatformTokens(tenantId: string): Promise<number> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('tenant_ai_usage')
    .select('tokens_in, tokens_out')
    .eq('tenant_id', tenantId)
    .eq('period_month', currentPeriodMonth())
    .maybeSingle();
  const r = data as { tokens_in: number; tokens_out: number } | null;
  return r ? Number(r.tokens_in) + Number(r.tokens_out) : 0;
}

/** Accumulate a completion's tokens against the current month (atomic upsert-add). */
export async function recordPlatformTokens(tenantId: string, tokensIn: number, tokensOut: number): Promise<void> {
  if (tokensIn <= 0 && tokensOut <= 0) return;
  const sb = createServiceClient();
  await sb.rpc('add_ai_usage', {
    p_tenant: tenantId,
    p_month: currentPeriodMonth(),
    p_in: Math.max(0, Math.round(tokensIn)),
    p_out: Math.max(0, Math.round(tokensOut)),
  });
}

export interface PlatformAiBudget {
  /** Whether the tenant's plan includes the platform AI. */
  entitled: boolean;
  used: number;
  /** Monthly token cap, or null when the plan grants no explicit limit (unlimited). */
  limit: number | null;
  remaining: number | null;
  withinBudget: boolean;
}

/** Resolve a tenant's platform-AI entitlement + this month's budget position. */
export async function getPlatformAiBudget(tenantId: string): Promise<PlatformAiBudget> {
  const ent = await resolveEntitlementsForTenant(tenantId);
  const entitled = ent.features.has(PLATFORM_FEATURE);
  const limit = typeof ent.limits[BUDGET_LIMIT_KEY] === 'number' ? ent.limits[BUDGET_LIMIT_KEY] : null;
  const used = await getMonthlyPlatformTokens(tenantId);
  const remaining = limit == null ? null : Math.max(0, limit - used);
  const withinBudget = !entitled ? false : limit == null ? true : used < limit;
  return { entitled, used, limit, remaining, withinBudget };
}
