-- 0020 — online agreement signing + PCN liability transfer (P2a).
--
-- A signing_session is a shareable, tokenised flow: ops create it, the partner
-- opens their link and confirms the deal figures, the driver opens their link and
-- signs. The signed agreement is then the evidence used to transfer a PCN's
-- liability to that driver (charge_liability_transfers) within the reporting
-- deadline — the "transfer PCN liability fast" the business asked for.

create type signing_status as enum ('partner_review', 'driver_sign', 'signed', 'declined', 'cancelled');

create table signing_sessions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  agreement_id        uuid not null references agreements(id) on delete cascade,
  reference           text not null,
  status              signing_status not null default 'partner_review',
  partner_token       text not null unique,
  driver_token        text not null unique,
  -- editable snapshot of the deal figures (seeded from the agreement)
  weekly_gross_pence  bigint not null,
  deposit_pence       bigint not null,
  vehicle_value_pence bigint,
  per_mile_pence      bigint not null default 100,
  start_mileage       text,
  -- partner step
  partner_name        text,
  partner_approved_at timestamptz,
  -- driver step
  driver_name         text,
  driver_signed_at    timestamptz,
  signer_ip           text,
  signed_html         text,          -- the signed document as submitted by the driver
  created_by          uuid references profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index signing_sessions_agreement_idx on signing_sessions (agreement_id);
create index signing_sessions_tenant_idx on signing_sessions (tenant_id);
create trigger trg_signing_sessions_updated before update on signing_sessions
  for each row execute function set_updated_at();

create table charge_liability_transfers (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  charge_id          uuid not null references charges(id) on delete cascade,
  driver_id          uuid not null references drivers(id),
  agreement_id       uuid references agreements(id),
  signing_session_id uuid references signing_sessions(id),
  reference          text not null,
  method             text not null default 'signed_agreement',   -- evidence basis
  note               text,
  transferred_by     uuid references profiles(id),
  transferred_at     timestamptz not null default now()
);
create index clt_charge_idx on charge_liability_transfers (charge_id);
create index clt_tenant_idx on charge_liability_transfers (tenant_id);

-- RLS: ops manage within their tenant; public sign access is by token via the
-- service role (which bypasses RLS). Restrictive tenant isolation on both.
alter table signing_sessions enable row level security;
alter table charge_liability_transfers enable row level security;

create policy signing_ops on signing_sessions for all to authenticated
  using (is_ops()) with check (is_ops());
create policy signing_tenant_iso on signing_sessions as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));

create policy clt_ops on charge_liability_transfers for all to authenticated
  using (is_ops()) with check (is_ops());
create policy clt_tenant_iso on charge_liability_transfers as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));

grant select, insert, update on signing_sessions to authenticated;
grant select, insert on charge_liability_transfers to authenticated;
