-- 0001 — extensions, shared helpers, and domain enums
-- Money is stored everywhere as integer PENCE (bigint) to avoid floating-point error.

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;      -- case-insensitive email

-- updated_at maintenance ------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Domain enums ----------------------------------------------------------------
create type user_role        as enum ('ops','driver','investor');
create type fuel_type         as enum ('phev','ev','petrol','diesel','hybrid');
create type vehicle_status    as enum ('available','on_hire','off_road','sold');
create type driver_status     as enum ('lead','vetting','active','suspended','terminated');
create type agreement_type    as enum ('standard','rtb');
create type agreement_status  as enum ('draft','pending_signature','active','ended','defaulted','transferred');
create type gfv_status        as enum ('unconfirmed','confirmed','settled','na');
create type rent_status       as enum ('due','paid','part_paid','overdue','waived');
create type invoice_status    as enum ('open','paid','part_paid','void','overdue');
create type payment_source    as enum ('manual','bank_transfer','gocardless','stripe','cash');
create type payment_status    as enum ('pending','confirmed','failed','refunded');
create type deposit_event     as enum ('held','deducted','refunded','forfeited');
create type charge_type       as enum ('pcn','congestion','ulez','dartford','toll','other');
create type charge_status     as enum ('received','driver_notified','driver_liable','disputed','paid_by_driver','paid_by_company','cancelled');
create type maintenance_payer as enum ('company','driver');
create type cert_status       as enum ('pending','verified','rejected','expired');
create type obligation_type   as enum ('insurance_expiry','pco_licence_expiry','dvla_check','mot','ved_renewal','gfv_settlement','agreement_end','service_due','pcn_report');
create type obligation_status as enum ('open','due_soon','overdue','resolved','dismissed');
create type severity          as enum ('info','warning','critical');
