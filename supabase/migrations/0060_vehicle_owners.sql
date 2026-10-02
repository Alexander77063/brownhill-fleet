-- 0060 — vehicle owners: the entity, its link to an account, RLS, and login codes.
--
-- Nigeria sells vehicle protection to people who own the vehicle but do not run
-- the tenant: an insurer's policyholders, or an individual on the shared
-- instance. They need an identity the tenant's staff can attach a vehicle to
-- BEFORE the person has ever signed in, and an account link written in exactly
-- one place once they do — the same two-sided shape drivers use
-- (drivers.id ← profiles.driver_id, current_driver_id()).
--
-- Phone is the identity key (many owners have no working email), normalised to
-- E.164 in code and unique per tenant.

create table vehicle_owners (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  user_id          uuid references profiles(id) on delete set null,
  name             text not null,
  phone            text not null,
  email            citext,
  nin              text,
  -- Alert thresholds (NG-4b reads them). Seeded with the product defaults; the
  -- owner may change them, staff may change them.
  night_from       time not null default '22:00',
  night_to         time not null default '05:00',
  timezone         text not null default 'Africa/Lagos',
  speed_limit_kph  int  not null default 100 check (speed_limit_kph between 30 and 250),
  offline_after_h  int  not null default 12  check (offline_after_h between 1 and 168),
  alerts_sms       boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, phone)
);
create trigger trg_vehicle_owners_updated before update on vehicle_owners
  for each row execute function set_updated_at();
create index vehicle_owners_user_idx on vehicle_owners (user_id) where user_id is not null;

alter table vehicles add column owner_id uuid references vehicle_owners(id) on delete set null;
create index vehicles_owner_idx on vehicles (tenant_id, owner_id) where owner_id is not null;

alter table profiles add column vehicle_owner_id uuid references vehicle_owners(id) on delete set null;

-- Which owner the current request IS. Mirrors current_driver_id() (0017).
create or replace function current_vehicle_owner_id() returns uuid
  language sql stable security definer set search_path = public as $$
    select vehicle_owner_id from profiles where id = current_app_user();
  $$;

-- Does the current owner own this vehicle? SECURITY DEFINER so policies on the
-- dependent tables do not re-enter the vehicles policy (mirrors owns_agreement).
create or replace function owns_vehicle(p_vehicle uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from vehicles v
      where v.id = p_vehicle and v.owner_id is not null
        and v.owner_id = current_vehicle_owner_id());
  $$;

-- vehicle_owners policies. Restrictive tenant isolation first (0017 shape).
alter table vehicle_owners enable row level security;
create policy vehicle_owners_iso on vehicle_owners as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy vehicle_owners_ops on vehicle_owners for all to authenticated
  using (is_ops()) with check (is_ops());
create policy vehicle_owners_self_select on vehicle_owners for select to authenticated
  using (id = current_vehicle_owner_id());
create policy vehicle_owners_self_update on vehicle_owners for update to authenticated
  using (id = current_vehicle_owner_id()) with check (id = current_vehicle_owner_id());

-- An owner may change their own contact details and alert settings, and nothing
-- else: not the phone that identifies them, not the tenant, not the account
-- link. Staff and the service role are unaffected.
create or replace function vehicle_owners_guard_self_update() returns trigger
  language plpgsql as $$
begin
  if new.id = current_vehicle_owner_id() and not is_ops() then
    if new.tenant_id is distinct from old.tenant_id
       or new.user_id is distinct from old.user_id
       or new.phone is distinct from old.phone
       or new.nin is distinct from old.nin
       or new.created_at is distinct from old.created_at then
      raise exception 'owners may change only their contact details and alert settings';
    end if;
  end if;
  return new;
end; $$;
create trigger trg_vehicle_owners_guard before update on vehicle_owners
  for each row execute function vehicle_owners_guard_self_update();

-- What an owner may READ about their vehicles. Each table already carries a
-- restrictive tenant-isolation policy, so the owner must also be a member of
-- the tenant (the link function writes that membership).
create policy vehicles_owner_select on vehicles for select to authenticated
  using (owner_id is not null and owner_id = current_vehicle_owner_id());
create policy positions_owner_select on vehicle_positions for select to authenticated
  using (owns_vehicle(vehicle_id));
create policy vph_owner_select on vehicle_position_history for select to authenticated
  using (owns_vehicle(vehicle_id));
create policy vehicle_compliance_owner_select on vehicle_compliance for select to authenticated
  using (owns_vehicle(vehicle_id));
create policy fuel_logs_owner_select on fuel_logs for select to authenticated
  using (owns_vehicle(vehicle_id));
create policy maint_owner_select on maintenance_records for select to authenticated
  using (owns_vehicle(vehicle_id));
create policy devices_owner_select on telematics_devices for select to authenticated
  using (owns_vehicle(vehicle_id));
create policy immob_owner_select on immobilisation_commands for select to authenticated
  using (owns_vehicle(vehicle_id));

-- profiles_self_select used auth.uid() directly, which is null on the local-auth
-- path (the GUC carries the user there). current_app_user() covers both.
drop policy if exists profiles_self_select on profiles;
create policy profiles_self_select on profiles for select to authenticated
  using (id = current_app_user() or is_ops());

-- One-time sign-in codes for phone OTP. Public schema so it exists on both
-- Supabase and the plain-Postgres shim; reachable only over the app's direct
-- database connection, never through the API roles.
create table login_codes (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,
  code_hash     text not null,
  expires_at    timestamptz not null,
  attempts      int not null default 0,
  consumed_at   timestamptz,
  requested_ip  text,
  created_at    timestamptz not null default now()
);
create index login_codes_phone_idx on login_codes (phone, created_at desc);
create index login_codes_ip_idx on login_codes (requested_ip, created_at desc);
alter table login_codes enable row level security;
revoke all on login_codes from anon, authenticated, service_role;
