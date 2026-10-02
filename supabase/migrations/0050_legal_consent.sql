-- 0050 — legal acceptance audit trail. Records each time a tenant (via an owner/
-- admin) accepts the CURRENT version of the Terms / Privacy Policy / Acceptable Use
-- Policy. Versioned, so publishing a new version forces re-acceptance. The signup
-- request also records the version the applicant agreed to at request time.

create table if not exists legal_acceptances (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null,
  version     text not null,
  documents   text[] not null default array['terms', 'privacy', 'acceptable-use'],
  ip          text,
  accepted_at timestamptz not null default now()
);
create index if not exists legal_acceptances_tenant_idx on legal_acceptances (tenant_id, version);

alter table legal_acceptances enable row level security;
drop policy if exists legal_ops on legal_acceptances;
create policy legal_ops on legal_acceptances for all to authenticated using (is_ops()) with check (is_ops());
drop policy if exists legal_iso on legal_acceptances;
create policy legal_iso on legal_acceptances as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select on legal_acceptances to authenticated;

-- Version of the Terms/Privacy the applicant agreed to on the request-access form.
alter table tenant_signup_requests add column if not exists terms_version text;
