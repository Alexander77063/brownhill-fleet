-- Seed: realistic Elite Fleet Management demo data drawn from the investor memorandum.
-- Domain rows only. Demo auth users (ops/driver/investor) are created by
-- `node scripts/seed-auth.mjs` which links the demo driver to DRIVER #1 below.
-- Money is in pence.

-- ── tenant attribution ──────────────────────────────────────────────────────
-- Every row in this file belongs to the one demo tenant. Migration 0052
-- deliberately removed the transitional tenant_id column default so that an
-- application write which forgets tenant_id fails loudly (23502) instead of
-- silently landing in the wrong tenant's books — see docs/MULTI-TENANCY.md.
--
-- That guarantee is about APPLICATION code. This file is single-tenant demo
-- data, so rather than repeat the same id across 16 INSERTs (and risk one
-- being missed), the default is reinstated for the duration of the seed and
-- dropped again at the bottom. The database is therefore fail-closed again the
-- moment seeding finishes, and `supabase db reset` re-runs this from scratch.
do $$
declare t text;
begin
  foreach t in array array[
    'vehicles','finance_agreements','drivers','agreements','deposit_ledger',
    'rent_schedule','invoices','payments','payment_allocations',
    'rtb_equity_ledger','maintenance_records','void_events','charges',
    'obligations','insurance_certificates'
  ] loop
    execute format(
      'alter table %I alter column tenant_id set default %L',
      t, 'b1111111-1111-1111-1111-111111111111');
  end loop;
end $$;

-- Fixed UUIDs so other scripts/tests can reference seeded rows ----------------
-- vehicles
--   v1 LX24 AAA (RTB, on hire, rich history)   v2 LX24 BBB (standard, on hire)
--   v3 LX24 CCC (standard, on hire)            v4 LX24 DDD (available)
-- drivers d1..d4 ; agreements a1..a4

insert into vehicles (id, registration, vin, colour, model_year, co2_gkm, ev_range_miles,
  list_value_pence, status, acquired_on, ved_annual_pence, ved_renewal_on, mot_due_on, residual_estimate_pence)
values
 ('11111111-1111-1111-1111-111111111111','LX24 AAA','WDD2221761A111111','Obsidian Black',2024,32,65,
   11700000,'on_hire','2024-01-15',60500,'2026-01-15','2027-01-14',5850000),
 ('22222222-2222-2222-2222-222222222222','LX24 BBB','WDD2221761A222222','Selenite Grey',2024,33,64,
   11700000,'on_hire','2024-06-01',60500,'2026-06-01','2027-05-31',6100000),
 ('33333333-3333-3333-3333-333333333333','LX24 CCC','WDD2221761A333333','Diamond White',2025,31,66,
   11700000,'on_hire','2025-02-10',60500,'2026-02-10','2028-02-09',7000000),
 ('44444444-4444-4444-4444-444444444444','LX24 DDD','WDD2221761A444444','Emerald Green',2025,30,67,
   11700000,'available','2025-09-01',60500,'2026-09-01','2028-08-31',7200000);

insert into finance_agreements (vehicle_id, funder, reference, initial_rental_pence, monthly_payment_pence,
  apr, term_months, start_on, amount_financed_pence, gfv_amount_pence, gfv_status, gfv_due_on)
values
 ('11111111-1111-1111-1111-111111111111','Mercedes-Benz Financial Services','MBFS-AAA-2024',2000000,160400,13.00,48,'2024-01-15',9700000,3500000,'unconfirmed','2027-01-15'),
 ('22222222-2222-2222-2222-222222222222','Mercedes-Benz Financial Services','MBFS-BBB-2024',2000000,160400,13.00,48,'2024-06-01',9700000,3500000,'unconfirmed','2027-06-01'),
 ('33333333-3333-3333-3333-333333333333','Mercedes-Benz Financial Services','MBFS-CCC-2025',2000000,160400,13.00,48,'2025-02-10',9700000,4000000,'confirmed','2028-02-10'),
 ('44444444-4444-4444-4444-444444444444','Mercedes-Benz Financial Services','MBFS-DDD-2025',2000000,160400,13.00,48,'2025-09-01',9700000,4000000,'unconfirmed','2028-09-01');

insert into drivers (id, full_name, email, phone, address, date_of_birth, status,
  pco_licence_no, pco_licence_expiry, dvla_licence_no, dvla_check_code, dvla_checked_on)
values
 ('d1111111-1111-1111-1111-111111111111','Samuel Okonkwo','sam.driver@elitefleetmanagement.test','+447700900001','12 Mayfair Mews, London W1','1986-04-12','active','PCO-114829','2026-09-30','OKONK860412SX9AB','Ab12 Cd34','2026-01-10'),
 ('d2222222-2222-2222-2222-222222222222','Daniel Hughes','daniel.h@example.test','+447700900002','5 Canary Wharf, London E14','1990-11-03','active','PCO-220117','2026-08-15','HUGHE901103DH7XY','Ef56 Gh78','2026-03-02'),
 ('d3333333-3333-3333-3333-333333333333','Marcus Bell','marcus.b@example.test','+447700900003','88 Kensington High St, London W8','1982-07-21','active','PCO-330942','2026-07-05','BELLM820721MB3QR','Ij90 Kl12','2026-02-18'),
 ('d4444444-4444-4444-4444-444444444444','Aisha Rahman','aisha.r@example.test','+447700900004','3 Shoreditch High St, London E1','1994-02-28','vetting','PCO-441276','2027-01-20',null,null,null);

insert into agreements (id, type, vehicle_id, driver_id, status, start_date, term_weeks,
  weekly_gross_pence, weekly_net_pence, weekly_vat_pence, deposit_pence,
  option_credit_weekly_pence, agreed_residual_pence, excess_mile_pence, signed_on)
values
 -- a1: RTB on v1, started ~30 weeks ago, rich history (RTB excess is 15p/mile)
 ('a1111111-1111-1111-1111-111111111111','rtb','11111111-1111-1111-1111-111111111111','d1111111-1111-1111-1111-111111111111','active',(current_date - 210),156,102000,85000,17000,500000,16250,3500000,15,(current_date - 212)),
 -- a2: standard on v2 (default £1.00/mile)
 ('a2222222-2222-2222-2222-222222222222','standard','22222222-2222-2222-2222-222222222222','d2222222-2222-2222-2222-222222222222','active',(current_date - 140),null,82500,68750,13750,100000,null,null,100,(current_date - 142)),
 -- a3: standard on v3 (custom £1.20/mile — proves the charge is data-driven)
 ('a3333333-3333-3333-3333-333333333333','standard','33333333-3333-3333-3333-333333333333','d3333333-3333-3333-3333-333333333333','active',(current_date - 70),null,82500,68750,13750,100000,null,null,120,(current_date - 72)),
 -- a4: RTB draft for v4 + d4 (pending)
 ('a4444444-4444-4444-4444-444444444444','rtb','44444444-4444-4444-4444-444444444444','d4444444-4444-4444-4444-444444444444','draft',null,156,102000,85000,17000,500000,16250,3500000,15,null);

-- Deposits held
insert into deposit_ledger (agreement_id, event, amount_pence, reason, occurred_on) values
 ('a1111111-1111-1111-1111-111111111111','held',500000,'RTB security deposit',(current_date - 210)),
 ('a2222222-2222-2222-2222-222222222222','held',100000,'Standard rental deposit',(current_date - 140)),
 ('a3333333-3333-3333-3333-333333333333','held',100000,'Standard rental deposit',(current_date - 70));

-- Generate 30 weeks of rent schedule + invoices for the RTB agreement a1, and
-- payments for the first 28 (2 weeks in arrears, for a realistic dashboard).
do $$
declare
  v_ag uuid := 'a1111111-1111-1111-1111-111111111111';
  v_start date := (current_date - 210);
  wk int;
  v_ps date; v_pe date;
  inv uuid; pay uuid;
begin
  for wk in 1..30 loop
    v_ps := v_start + (wk-1)*7;
    v_pe := v_ps + 6;
    insert into rent_schedule (agreement_id, week_no, period_start, period_end,
      gross_due_pence, net_due_pence, vat_due_pence,
      status)
    values (v_ag, wk, v_ps, v_pe, 102000, 85000, 17000,
      (case when wk <= 28 then 'paid' else 'due' end)::rent_status);

    insert into invoices (agreement_id, number, issued_on, due_on, gross_pence, net_pence, vat_pence)
    values (v_ag, 'BRH-A1-'||lpad(wk::text,4,'0'), v_ps, v_ps, 102000, 85000, 17000)
    returning id into inv;

    if wk <= 28 then
      insert into payments (driver_id, agreement_id, source, idempotency_key, amount_pence, received_on, status)
      values ('d1111111-1111-1111-1111-111111111111', v_ag, 'gocardless',
        'seed-gc-a1-'||wk, 102000, v_ps + 1, 'confirmed')
      returning id into pay;
      insert into payment_allocations (payment_id, invoice_id, amount_pence)
      values (pay, inv, 102000);
    end if;
  end loop;
end $$;

-- RTB equity ledger for a1: deposit + £162.50/wk for 30 weeks
do $$
declare
  v_ag uuid := 'a1111111-1111-1111-1111-111111111111';
  v_start date := (current_date - 210);
  wk int; cum bigint := 0; dep bigint := 500000;
begin
  insert into rtb_equity_ledger (agreement_id, week_no, credit_pence, cumulative_credit_pence, deposit_pence, equity_total_pence, as_of)
  values (v_ag, 0, 0, 0, dep, dep, v_start);
  for wk in 1..30 loop
    cum := cum + 16250;
    insert into rtb_equity_ledger (agreement_id, week_no, credit_pence, cumulative_credit_pence, deposit_pence, equity_total_pence, as_of)
    values (v_ag, wk, 16250, cum, dep, cum + dep, v_start + wk*7);
  end loop;
end $$;

-- Maintenance (company pays standard-rental vehicles)
insert into maintenance_records (vehicle_id, payer, description, cost_pence, service_on, odometer_miles) values
 ('22222222-2222-2222-2222-222222222222','company','A-service + brake pads',42000,(current_date - 60),18450),
 ('33333333-3333-3333-3333-333333333333','company','Tyre replacement (x2)',38000,(current_date - 25),9200),
 ('11111111-1111-1111-1111-111111111111','driver','B-service (RTB driver-paid)',61000,(current_date - 40),28700);

-- A short void on v2 (off-road for body repair)
insert into void_events (vehicle_id, reason, start_on, end_on) values
 ('22222222-2222-2222-2222-222222222222','Bodyshop — rear bumper',(current_date - 20),(current_date - 13));

-- Charges pass-through
insert into charges (vehicle_id, driver_id, agreement_id, type, authority, reference, incident_on, received_on, report_due_at, amount_pence, status) values
 ('11111111-1111-1111-1111-111111111111','d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','pcn','Westminster CC','WCC-99213',(current_date - 5),(current_date - 3),(now() - interval '1 day'),13000,'driver_notified'),
 ('33333333-3333-3333-3333-333333333333','d3333333-3333-3333-3333-333333333333','a3333333-3333-3333-3333-333333333333','dartford','Dart Charge','DC-55120',(current_date - 2),(current_date - 1),(now() + interval '1 day'),250,'received');

-- Obligations (compliance alerts). Insurance + GFV + MOT examples.
insert into obligations (entity_type, entity_id, type, title, due_date, severity, status) values
 ('driver','d2222222-2222-2222-2222-222222222222','pco_licence_expiry','PCO licence renewal — Daniel Hughes',(current_date + 21),'warning','due_soon'),
 ('driver','d3333333-3333-3333-3333-333333333333','pco_licence_expiry','PCO licence renewal — Marcus Bell',(current_date + 7),'critical','due_soon'),
 ('finance_agreement','11111111-1111-1111-1111-111111111111','gfv_settlement','RTB GFV settlement due — LX24 AAA',(current_date + 280),'critical','open'),
 ('vehicle','22222222-2222-2222-2222-222222222222','ved_renewal','VED renewal — LX24 BBB',(current_date + 45),'info','open'),
 ('agreement','a1111111-1111-1111-1111-111111111111','pcn_report','PCN 48h report overdue — WCC-99213',(current_date - 1),'critical','overdue');

-- Insurance certificates
insert into insurance_certificates (driver_id, agreement_id, insurer, policy_no, cover_from, cover_to, company_interested_party, status) values
 ('d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','Aviva PCO','AV-PCO-11001',(current_date - 60),(current_date + 30),true,'verified'),
 ('d2222222-2222-2222-2222-222222222222','a2222222-2222-2222-2222-222222222222','Zego','ZG-77410',(current_date - 90),(current_date + 5),true,'verified'),
 ('d3333333-3333-3333-3333-333333333333','a3333333-3333-3333-3333-333333333333','AXA Fleet','AX-30551',(current_date - 30),(current_date + 90),true,'verified');

-- ── restore fail-closed ─────────────────────────────────────────────────────
-- Drop the seed-scoped defaults set at the top of this file. From here on an
-- INSERT that omits tenant_id raises 23502, which is the point of 0052.
do $$
declare t text;
begin
  foreach t in array array[
    'vehicles','finance_agreements','drivers','agreements','deposit_ledger',
    'rent_schedule','invoices','payments','payment_allocations',
    'rtb_equity_ledger','maintenance_records','void_events','charges',
    'obligations','insurance_certificates'
  ] loop
    execute format('alter table %I alter column tenant_id drop default', t);
  end loop;
end $$;
