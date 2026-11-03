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

-- ── The invoices and payments a live deployment would already hold ────────
--
-- The ledger backfill (migration 0086) has the same shape of problem as 0077,
-- and the same answer. From zero, its backfill updates zero rows and its
-- assertions are never exercised; a live deployment has thirty weeks of rent
-- invoices and the money that came in against them — every one of them with
-- `posted_journal_id` null and `vat_code_id` null, because nothing posted
-- them and nothing ever wrote a VAT code onto them.
--
-- So the fixture carries them:
--
--   BRH-BF-0001  standard-rated, April,  £1,020.00   (net 850.00, VAT 170.00)
--   BRH-BF-0002  standard-rated, May,     £825.00   (net 687.50, VAT 137.50)
--   BRH-BF-0003  ZERO-RATED,   June,    £1,020.00   (net 1,020.00, VAT 0.00)
--   BRH-BF-0004  VOID,         June,    £1,020.00   (net 850.00, VAT 170.00)
--
--   bf-gc-1      confirmed payment, April, £1,020.00
--   bf-gc-2      PENDING  payment, April, £1,020.00
--   bf-gc-3      FAILED   payment, April, £1,020.00
--
-- Each one is there for a reason, and each is a way the backfill can be
-- wrong:
--
--   * the zero-rated one proves the VAT line is LEFT OUT. A line that is zero
--     on both sides is not a zero line — it is an ILLEGAL line, because
--     `journal_lines` carries `check ((debit_pence > 0) <> (credit_pence > 0))`.
--     Writing one takes the whole entry down with it, and the rent for that
--     week is never billed.
--
--   * the void one proves a cancelled invoice is not posted. A cancelled
--     invoice has no revenue.
--
--   * the pending and failed ones prove that money which did not arrive is
--     not posted. A pending payment is not a receipt.
--
-- The months are fixed rather than relative, because the assertions name the
-- month each posting must land in — a backfill that puts an April invoice in
-- today's month is wrong, and only a fixed date can say so.
insert into invoices (agreement_id, number, issued_on, due_on, gross_pence, net_pence,
                      vat_pence, status, tenant_id)
values
 ('a1111111-1111-1111-1111-111111111111','BRH-BF-0001','2026-04-06','2026-04-06',102000,85000,17000,'open','b1111111-1111-1111-1111-111111111111'),
 ('a1111111-1111-1111-1111-111111111111','BRH-BF-0002','2026-05-04','2026-05-04', 82500,68750,13750,'open','b1111111-1111-1111-1111-111111111111'),
 ('a1111111-1111-1111-1111-111111111111','BRH-BF-0003','2026-06-01','2026-06-01',102000,102000,    0,'open','b1111111-1111-1111-1111-111111111111'),
 ('a1111111-1111-1111-1111-111111111111','BRH-BF-0004','2026-06-15','2026-06-15',102000,85000,17000,'void','b1111111-1111-1111-1111-111111111111');

insert into payments (driver_id, agreement_id, source, idempotency_key, amount_pence,
                      received_on, status, tenant_id)
values
 ('d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','gocardless','bf-gc-1',102000,'2026-04-07','confirmed','b1111111-1111-1111-1111-111111111111'),
 ('d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','gocardless','bf-gc-2',102000,'2026-04-08','pending', 'b1111111-1111-1111-1111-111111111111'),
 ('d1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111','gocardless','bf-gc-3',102000,'2026-04-09','failed',  'b1111111-1111-1111-1111-111111111111');

-- The confirmed payment is allocated to the April invoice, which is what a
-- live book looks like: the money that came in against the bill it settles.
insert into payment_allocations (payment_id, invoice_id, amount_pence, tenant_id)
select p.id, i.id, p.amount_pence, p.tenant_id
  from payments p
  join invoices i on i.number = 'BRH-BF-0001'
 where p.idempotency_key = 'bf-gc-1';

\echo '--- the invoices and payments as 0086 will find them'
select number, issued_on, gross_pence, net_pence, vat_pence, status::text,
       posted_journal_id is null as unposted, vat_code_id is null as uncoded
  from invoices order by number;
select idempotency_key, received_on, amount_pence, status::text,
       posted_journal_id is null as unposted
  from payments order by idempotency_key;

\echo '=== BACKFILL FIXTURE LOADED ==='
