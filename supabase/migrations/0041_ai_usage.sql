-- 0041 — hybrid AI: platform-provided AI by default, metered + capped per tenant.
--
-- Tenants without their own provider key use the platform AI account; usage is
-- metered per calendar month and capped by a plan limit (plans.limits key
-- 'ai.platform.tokens'). Tenants that bring their own key are billed by their own
-- provider and are NOT metered here. `ai.platform` is a plan feature granted to
-- every tier so the assistant works out of the box.

create table tenant_ai_usage (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  period_month date not null,                 -- first day of the month (UTC)
  tokens_in    bigint not null default 0,
  tokens_out   bigint not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, period_month)
);

alter table tenant_ai_usage enable row level security;
-- Members may read their own tenant's usage (for the in-app meter); writes are
-- service-role only (no insert/update policy).
create policy "ai_usage read own" on tenant_ai_usage for select to authenticated
  using (is_tenant_member(tenant_id));
grant select on tenant_ai_usage to authenticated;

-- Atomic accumulate — called by the server with the service role after each
-- platform AI completion.
create or replace function add_ai_usage(p_tenant uuid, p_month date, p_in bigint, p_out bigint)
returns void language sql security definer set search_path = public as $$
  insert into tenant_ai_usage (tenant_id, period_month, tokens_in, tokens_out, updated_at)
  values (p_tenant, p_month, p_in, p_out, now())
  on conflict (tenant_id, period_month) do update
    set tokens_in  = tenant_ai_usage.tokens_in  + excluded.tokens_in,
        tokens_out = tenant_ai_usage.tokens_out + excluded.tokens_out,
        updated_at = now();
$$;

-- Grant the bundled platform AI to every plan (idempotent).
insert into plan_features (plan_id, feature_key)
select p.id, 'ai.platform'
from plans p
where not exists (
  select 1 from plan_features f where f.plan_id = p.id and f.feature_key = 'ai.platform'
);

-- Monthly platform-AI token budgets by tier. BYO-key tenants are unmetered.
update plans set limits = limits || '{"ai.platform.tokens": 50000}'::jsonb    where key = 'trial';
update plans set limits = limits || '{"ai.platform.tokens": 300000}'::jsonb   where key = 'starter';
update plans set limits = limits || '{"ai.platform.tokens": 1000000}'::jsonb  where key = 'growth';
update plans set limits = limits || '{"ai.platform.tokens": 4000000}'::jsonb  where key = 'scale';
