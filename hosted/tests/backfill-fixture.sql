-- hosted/tests/backfill-fixture.sql — pre-rent-to-buy-contract data.
--
-- Applied to the `backfill` database by hosted/tests/migrations-regression.sh,
-- immediately before migration 0077, so that 0077's backfill is exercised
-- against a table that ALREADY has rent-to-buy agreements in it.
--
-- Why this matters: the from-zero replay (phase 1 of the harness) applies 0077
-- to an empty `agreements` table, so its backfill updates zero rows and its
-- CHECK constraint is validated against zero rows. A live deployment is the
-- opposite: the rent-to-buy book already exists. If the backfill's arithmetic
-- were wrong, or if it missed a row, phase 1 would still be green and the
-- deploy would fail at the worst possible moment.
--
-- This fixture is therefore the shape a live deployment actually has on the
-- day 0077 is applied: an agreement that knows only the WEEKLY billing. There
-- is no term_months, no monthly_gross_pence and no agreed_vehicle_price_pence,
-- because those columns do not exist yet — their absence is the point.
--
-- The figures are the seeded deal: 156 weeks at £1,020.00 a week, £5,000
-- deposit, £162.50 a week of buyout credit, £35,000 residual, car list value
-- £117,000. The arithmetic is exact — 156 weeks is 36 months
-- (156 x 12 / 52 = 36), and £1,020 x 156 = £159,120 = £4,420 x 36.
--
-- A standard rental is inserted alongside it so the assertions can prove 0077
-- did not touch the rows it is not meant to touch.
--
-- tenant_id is supplied on every insert because migration 0052 removed the
-- transitional default: an insert that forgets it must fail loudly rather
-- than land in the wrong tenant's books.

\set ON_ERROR_STOP on

insert into vehicles (id, registration, vin, colour, model_year, co2_gkm, ev_range_miles,
  list_value_pence, status, acquired_on, ved_annual_pence, ved_renewal_on, mot_due_on,
  residual_estimate_pence, tenant_id)
values
 ('11111111-1111-1111-1111-111111111111','LX24 AAA','WDD2221761A111111','Obsidian Black',2024,32,65,
   11700000,'on_hire','2024-01-15',60500,'2026-01-15','2027-01-14',5850000,
   'b1111111-1111-1111-1111-111111111111'),
 ('22222222-2222-2222-2222-222222222222','LX24 BBB','WDD2221761A222222','Selenite Grey',2024,33,64,
   11700000,'on_hire','2024-06-01',60500,'2026-06-01','2027-05-31',6100000,
   'b1111111-1111-1111-1111-111111111111');

insert into drivers (id, full_name, email, phone, address, date_of_birth, status,
  pco_licence_no, pco_licence_expiry, dvla_licence_no, dvla_check_code, dvla_checked_on, tenant_id)
values
 ('d1111111-1111-1111-1111-111111111111','Samuel Okonkwo','sam.driver@elitefleetmanagement.test','+447700900001','12 Mayfair Mews, London W1','1986-04-12','active','PCO-114829','2026-09-30','OKONK860412SX9AB','Ab12 Cd34','2026-01-10','b1111111-1111-1111-1111-111111111111'),
 ('d2222222-2222-2222-2222-222222222222','Daniel Hughes','daniel.h@example.test','+447700900002','5 Canary Wharf, London E14','1990-11-03','active','PCO-220117','2026-08-15','HUGHE901103DH7XY','Ef56 Gh78','2026-03-02','b1111111-1111-1111-1111-111111111111');

-- The rent-to-buy row. Note what is NOT here: term_months, monthly_gross_pence,
-- agreed_vehicle_price_pence, agreed_vehicle_cost_pence. Those are the columns
-- 0077 adds, and their absence is the whole test.
insert into agreements (id, type, vehicle_id, driver_id, status, start_date, term_weeks,
  weekly_gross_pence, weekly_net_pence, weekly_vat_pence, deposit_pence,
  option_credit_weekly_pence, agreed_residual_pence, excess_mile_pence, signed_on, tenant_id)
values ('a1111111-1111-1111-1111-111111111111','rtb',
        '11111111-1111-1111-1111-111111111111','d1111111-1111-1111-1111-111111111111',
        'active',(current_date - 210),156,102000,85000,17000,500000,16250,3500000,15,
        (current_date - 212),'b1111111-1111-1111-1111-111111111111');

-- A standard rental, which must come out of 0077 untouched.
insert into agreements (id, type, vehicle_id, driver_id, status, start_date, term_weeks,
  weekly_gross_pence, weekly_net_pence, weekly_vat_pence, deposit_pence,
  excess_mile_pence, signed_on, tenant_id)
values ('a2222222-2222-2222-2222-222222222222','standard',
        '22222222-2222-2222-2222-222222222222','d2222222-2222-2222-2222-222222222222',
        'active',(current_date - 140),null,82500,68750,13750,100000,100,
        (current_date - 142),'b1111111-1111-1111-1111-111111111111');

\echo '--- the rent-to-buy row as 0077 will find it'
select id, type, term_weeks, weekly_gross_pence, weekly_net_pence, weekly_vat_pence,
       deposit_pence, option_credit_weekly_pence, agreed_residual_pence
  from agreements order by id;

\echo '=== BACKFILL FIXTURE LOADED ==='
