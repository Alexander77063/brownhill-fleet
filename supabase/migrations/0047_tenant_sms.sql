-- 0047 — per-tenant BYO SMS (Twilio). Same boundary as email/payments: a tenant's
-- driver texts send from THEIR own Twilio account/number, not the platform. The
-- platform's Termii key (notify.ts) is unused for tenant→driver SMS after this.
-- BYO-only + fail-closed: no config → no send (still logged in-app).

create table tenant_sms_config (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  provider    text not null default 'twilio' check (provider in ('twilio')),
  sms_enabled boolean not null default false,
  account_sid text,   -- Twilio Account SID (AC…)
  from_number text,   -- the tenant's Twilio number, e.g. +447700900000
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);
alter table tenant_sms_config enable row level security;
create policy tenant_sms_config_read on tenant_sms_config
  for select to authenticated using (is_tenant_member(tenant_id));
grant select on tenant_sms_config to authenticated;

create table tenant_sms_secrets (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  kind       text not null check (kind in ('twilio_auth_token')),
  ciphertext text not null,
  iv         text not null,
  auth_tag   text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kind)
);
alter table tenant_sms_secrets enable row level security;
-- Deny-all: no policies, no grants — service-role only.
