-- 0016 — multi-tenant foundation: tenants, memberships, and portable identity helpers.
--
-- This is the SaaS backbone. Every future tenant-scoped table (F2) will carry a
-- tenant_id and gate on membership. The identity helpers below are deliberately
-- provider-agnostic: they prefer an explicit Postgres session variable (the path a
-- future AWS/Cognito + direct-Postgres deployment would use) and fall back to
-- Supabase's auth.uid() (today's PostgREST path). RLS policies call these helpers,
-- so the policies never change when the auth provider changes.

create type tenant_plan as enum ('trial', 'starter', 'growth', 'scale');
create type tenant_status as enum ('active', 'suspended', 'cancelled');
create type membership_status as enum ('active', 'invited', 'disabled');

create table tenants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null unique,
  plan         tenant_plan not null default 'trial',
  status       tenant_status not null default 'active',
  branding     jsonb not null default '{}'::jsonb,   -- logo_url, colours, etc. (per-tenant white-label)
  modules      jsonb not null default '{}'::jsonb,   -- feature toggles: which modules this tenant uses
  ref_prefixes jsonb not null default '{}'::jsonb,   -- numbering prefixes (INV/EXP/BKG/RCP...)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_tenants_updated before update on tenants
  for each row execute function set_updated_at();

create table tenant_memberships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  role        text not null default 'member',
  permissions text[] not null default '{}',
  status      membership_status not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index tenant_memberships_user_idx on tenant_memberships (user_id);
create index tenant_memberships_tenant_idx on tenant_memberships (tenant_id);
create trigger trg_memberships_updated before update on tenant_memberships
  for each row execute function set_updated_at();

-- ── Portable identity helpers ────────────────────────────────────────────────

-- Current user id: an explicit GUC (future direct-SQL path) wins; else auth.uid().
create or replace function current_app_user() returns uuid
  language sql stable as $$
    select coalesce(
      nullif(current_setting('app.user_id', true), '')::uuid,
      auth.uid()
    )
  $$;

-- Active tenant, if the request pinned one (null = "any tenant I'm a member of").
create or replace function current_app_tenant() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.tenant_id', true), '')::uuid
  $$;

-- Membership check. SECURITY DEFINER so a policy ON tenant_memberships can call it
-- without recursing through that table's own RLS.
create or replace function is_tenant_member(tid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from tenant_memberships m
      where m.tenant_id = tid
        and m.user_id = current_app_user()
        and m.status = 'active'
    )
  $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Reads are scoped to the caller's memberships. Writes (onboarding, invites) go
-- through the service role for now; IAM (F3) adds tenant-admin write policies.

alter table tenants enable row level security;
alter table tenant_memberships enable row level security;

create policy tenants_member_select on tenants for select to authenticated
  using (is_tenant_member(id));

create policy memberships_visible on tenant_memberships for select to authenticated
  using (user_id = current_app_user() or is_tenant_member(tenant_id));

grant select on tenants to authenticated;
grant select on tenant_memberships to authenticated;
