-- 0046 — per-tenant BYO email (tenant→driver comms sent from the tenant's own
-- account/domain). Mirrors the payments/AI BYO pattern: a member-readable config
-- table + a deny-all encrypted secret store (service-role only, AES-256-GCM via
-- TENANT_AI_ENC_KEY). The platform's own RESEND_API_KEY is used ONLY for
-- platform→tenant comms (subscription/billing) and is untouched by this.
--
-- BYO-only: a tenant that hasn't connected email doesn't send driver reminders
-- (they log as skipped) — the platform never sends on a tenant's behalf.

create table tenant_email_config (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  email_enabled boolean not null default false,
  provider      text not null default 'resend' check (provider in ('resend')),
  from_address  text,   -- a verified address on the tenant's own domain
  from_name     text,   -- display name (defaults to their branding)
  reply_to      text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);
alter table tenant_email_config enable row level security;
create policy tenant_email_config_read on tenant_email_config
  for select to authenticated using (is_tenant_member(tenant_id));
grant select on tenant_email_config to authenticated;

create table tenant_email_secrets (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  kind       text not null check (kind in ('resend_api_key')),
  ciphertext text not null,
  iv         text not null,
  auth_tag   text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kind)
);
alter table tenant_email_secrets enable row level security;
-- Intentionally NO policies and NO grants: deny-all, readable only via the
-- service role in server code, then decrypted in-process.
