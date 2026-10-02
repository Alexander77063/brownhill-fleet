-- 0033 — platform operator console (SP-F, Phase 4).
-- Two platform-scoped tables that back the super-admin console: a dedupe log for
-- subscription reminders (renewal / trial-ending / dunning) and a daily metrics
-- snapshot for MRR / churn trend charts. Both are GLOBAL (cross-tenant) and are
-- readable only by platform admins; writes come from the service role (cron +
-- server actions), which bypasses RLS. MRR itself is never stored on a tenant —
-- it is computed from the catalogue; only the daily aggregate is snapshotted here.

-- Dedupe log so a given reminder (tenant + kind + billing period) is sent at most
-- once. The unique constraint IS the idempotency guarantee for the cron.
create table subscription_reminders (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  kind       text not null check (kind in ('renewal_upcoming', 'trial_ending', 'past_due')),
  period_end timestamptz,
  channel    text,
  recipient  text,
  status     text not null default 'sent',
  detail     text,
  sent_at    timestamptz not null default now(),
  unique (tenant_id, kind, period_end)
);
create index subscription_reminders_tenant_idx on subscription_reminders (tenant_id, sent_at desc);

-- Daily platform snapshot. One row per UTC day (upserted by the lifecycle cron).
-- ARR is stored alongside MRR so trend queries don't have to re-derive it.
create table platform_metrics_daily (
  day               date primary key,
  tenants_total     int    not null default 0,
  tenants_active    int    not null default 0,
  tenants_trialing  int    not null default 0,
  tenants_past_due  int    not null default 0,
  tenants_cancelled int    not null default 0,
  paying_tenants    int    not null default 0,
  mrr_pence         bigint not null default 0,
  arr_pence         bigint not null default 0,
  captured_at       timestamptz not null default now()
);

-- Platform-admin-only visibility. Service role (cron/actions) bypasses RLS to write.
alter table subscription_reminders  enable row level security;
alter table platform_metrics_daily  enable row level security;

create policy subscription_reminders_read on subscription_reminders
  for select to authenticated using (is_platform_admin());
create policy platform_metrics_daily_read on platform_metrics_daily
  for select to authenticated using (is_platform_admin());

grant select on subscription_reminders to authenticated;
grant select on platform_metrics_daily to authenticated;
