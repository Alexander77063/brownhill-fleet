-- 0035 — per-tenant AI assistant ("platform enhancer"), bundled with tenancy.
-- Every tenant can enable an in-account AI assistant by bringing THEIR OWN
-- provider + API key. This is deliberately NOT a paid add-on and is distinct
-- from the platform-operator copilot: the tenant assistant only ever sees that
-- tenant's own data (queried through the RLS client), never cross-tenant.
--
-- Security model (defence in depth):
--  1. The API key is split into its own table (tenant_ai_secrets) with RLS
--     enabled and NO policies + no grants to authenticated → structurally
--     unreadable by tenant clients; only service_role touches it, server-side.
--  2. On top of that, the key is stored AES-256-GCM encrypted (app master key
--     in env), so even a service-role read yields ciphertext without the key.
-- The tenant UI only needs the non-secret config below + a "key is set?" boolean.

create table tenant_ai_config (
  tenant_id  uuid primary key references tenants(id) on delete cascade,
  provider   text not null default 'anthropic'
             check (provider in ('anthropic', 'openai', 'google')),
  model      text,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table tenant_ai_config enable row level security;

-- Members read their own tenant's non-secret config (to render the settings UI).
-- Writes go through a server action that re-checks membership and uses the
-- service role, so no write policy is granted to authenticated.
create policy tenant_ai_config_read on tenant_ai_config
  for select to authenticated using (is_tenant_member(tenant_id));
grant select on tenant_ai_config to authenticated;

-- The secret store. RLS enabled with NO policy and NO grant to authenticated =
-- deny-all to tenant clients (same pattern as billing_events). Only the service
-- role reads/writes it, server-side, to make provider calls.
create table tenant_ai_secrets (
  tenant_id  uuid primary key references tenants(id) on delete cascade,
  ciphertext text not null,
  iv         text not null,
  auth_tag   text not null,
  updated_at timestamptz not null default now()
);
alter table tenant_ai_secrets enable row level security;
-- intentionally: no policies, no grants to authenticated.
