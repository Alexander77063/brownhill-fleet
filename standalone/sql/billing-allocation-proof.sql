-- standalone/sql/billing-allocation-proof.sql
--
-- Proves the billing allocation guard: money may never be allocated to an
-- invoice that has been voided, and the two caps that were always there (the
-- payment's amount, the invoice's gross) still hold.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `public.payment_allocations` is the only link between a payment and an
-- invoice. The `check_allocation` trigger (migration 0006) caps an
-- allocation at the payment's amount and at the invoice's gross — but it says
-- nothing about the invoice's STATE.
--
-- An invoice that has been voided still exists, so a voided invoice was a
-- valid allocation target. That is not a theoretical hole: the reconciliation
-- queue allocates a receipt to whichever invoice the operator picks, the
-- bank-statement auto-matcher allocates to the best-scoring open invoice, and
-- the payment ingest pays down an agreement's invoices in order. None of them
-- asked the invoice whether it had been cancelled. Money lands against a debt
-- that was written off, and `sync_invoice_status` never clears 'void', so the
-- invoice keeps saying it was cancelled while carrying a payment.
--
-- The application checks the state before it allocates. The database is where
-- the guarantee belongs, though: the check has to hold for EVERY caller — the
-- ones that exist today and the ones that will be written later.
--
-- It ends in ROLLBACK, so it leaves no fixtures behind and can be run
-- repeatedly against the same database.
--
-- Run it with:
--   psql -v ON_ERROR_STOP=1 -f standalone/sql/billing-allocation-proof.sql
--
-- Each assertion gets its own invoice, so that one assertion cannot pass
-- because of another one's state. In particular the void test voids its own
-- invoice rather than a shared one: a voided invoice would make the gross-cap
-- assertion pass for the wrong reason.

\set ON_ERROR_STOP on

begin;

-- ── Fixtures ───────────────────────────────────────────────────────────────
--
-- tenant_id is supplied on every insert because migration 0052 removed the
-- transitional default: an insert that forgets it must fail loudly rather
-- than land in the wrong tenant's books.

insert into public.tenants (id, name, slug)
values ('b1111111-1111-1111-1111-111111111111', 'Elite Fleet Management', 'elite-fleet-management')
on conflict (id) do nothing;

insert into public.vehicles
  (id, registration, vin, colour, model_year, co2_gkm, ev_range_miles,
   list_value_pence, status, acquired_on, tenant_id)
values
  ('ba111111-1111-1111-1111-111111111111', 'LX24 PRF', 'WDD2221761P111111',
   'Obsidian Black', 2024, 32, 65, 11700000, 'on_hire', '2024-01-15',
   'b1111111-1111-1111-1111-111111111111');

insert into public.drivers
  (id, full_name, email, phone, address, date_of_birth, status, tenant_id)
values
  ('db111111-1111-1111-1111-111111111111', 'Proof Driver',
   'proof.driver@elitefleetmanagement.test', '+447700900003',
   '1 Proof Mews, London W1', '1990-01-01', 'active',
   'b1111111-1111-1111-1111-111111111111');

insert into public.agreements
  (id, type, vehicle_id, driver_id, status, start_date,
   weekly_gross_pence, weekly_net_pence, weekly_vat_pence, deposit_pence,
   excess_mile_pence, tenant_id)
values
  ('ab111111-1111-1111-1111-111111111111', 'standard',
   'ba111111-1111-1111-1111-111111111111', 'db111111-1111-1111-1111-111111111111',
   'active', current_date - 30, 100000, 83333, 16667, 0, 100,
   'b1111111-1111-1111-1111-111111111111');

-- Four invoices.
--
--   PRF-001  £1,000   the positive case, and the gross cap
--   PRF-002  £5,000   large enough that the payment cap is the one that bites
--   PRF-003  £5,000   large enough that the payment cap is the one that bites
--   PRF-004  £1,000   the one that gets voided
insert into public.invoices
  (id, agreement_id, number, issued_on, due_on, gross_pence, net_pence, vat_pence,
   status, tenant_id)
values
  ('c1111111-1111-1111-1111-111111111111', 'ab111111-1111-1111-1111-111111111111',
   'PRF-001', current_date, current_date + 7, 100000, 83333, 16667, 'open',
   'b1111111-1111-1111-1111-111111111111'),
  ('c2222222-2222-2222-2222-222222222222', 'ab111111-1111-1111-1111-111111111111',
   'PRF-002', current_date, current_date + 7, 500000, 416667, 83333, 'open',
   'b1111111-1111-1111-1111-111111111111'),
  ('c3333333-3333-3333-3333-333333333333', 'ab111111-1111-1111-1111-111111111111',
   'PRF-003', current_date, current_date + 7, 500000, 416667, 83333, 'open',
   'b1111111-1111-1111-1111-111111111111'),
  ('c4444444-4444-4444-4444-444444444444', 'ab111111-1111-1111-1111-111111111111',
   'PRF-004', current_date, current_date + 7, 100000, 83333, 16667, 'open',
   'b1111111-1111-1111-1111-111111111111');

-- Three payments, each £1,000, each used by one assertion. Separate payments
-- mean no assertion can pass because of a UNIQUE violation raised by an
-- earlier one.
insert into public.payments
  (id, driver_id, agreement_id, source, idempotency_key, amount_pence,
   received_on, status, external_ref, tenant_id)
values
  ('f1111111-1111-1111-1111-111111111111', 'db111111-1111-1111-1111-111111111111',
   'ab111111-1111-1111-1111-111111111111', 'bank_transfer', 'proof-alloc-1',
   100000, current_date, 'confirmed', 'proof-1',
   'b1111111-1111-1111-1111-111111111111'),
  ('f2222222-2222-2222-2222-222222222222', 'db111111-1111-1111-1111-111111111111',
   'ab111111-1111-1111-1111-111111111111', 'bank_transfer', 'proof-alloc-2',
   100000, current_date, 'confirmed', 'proof-2',
   'b1111111-1111-1111-1111-111111111111'),
  ('f3333333-3333-3333-3333-333333333333', 'db111111-1111-1111-1111-111111111111',
   'ab111111-1111-1111-1111-111111111111', 'bank_transfer', 'proof-alloc-3',
   100000, current_date, 'confirmed', 'proof-3',
   'b1111111-1111-1111-1111-111111111111');

-- ── A1. Money CAN be allocated to an open invoice ──────────────────────────
--
-- The positive case. A guard that refuses everything would pass A2 as well,
-- so the negative assertions below mean nothing without this one.

do $$
begin
  insert into public.payment_allocations (payment_id, invoice_id, amount_pence, tenant_id)
  values ('f1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111',
          10000, 'b1111111-1111-1111-1111-111111111111');
  raise notice 'PASS A1: money can be allocated to an open invoice';
exception when others then
  raise exception 'FAIL: an allocation to an open invoice was refused: %', sqlerrm;
end
$$;

-- ── A2. Money CANNOT be allocated to a void invoice ────────────────────────

do $$
declare
  refused boolean := false;
begin
  update public.invoices set status = 'void' where id = 'c4444444-4444-4444-4444-444444444444';

  begin
    insert into public.payment_allocations (payment_id, invoice_id, amount_pence, tenant_id)
    values ('f2222222-2222-2222-2222-222222222222', 'c4444444-4444-4444-4444-444444444444',
            10000, 'b1111111-1111-1111-1111-111111111111');
  exception when others then
    refused := true;
  end;

  if not refused then
    raise exception 'FAIL: an allocation to a void invoice was accepted — a voided invoice is a valid allocation target';
  end if;
  raise notice 'PASS A2: an allocation to a void invoice is refused';
end
$$;

-- ── A3. An allocation may not exceed the invoice's gross ───────────────────
--
-- The cap migration 0006 installed, kept here so the void guard cannot be
-- added by accident while removing something else. PRF-001 has £100.00 on it
-- from A1 and is worth £1,000.00, so £1,000.00 more takes it over the gross.
-- The payment behind it is worth £1,000.00 and has nothing else on it, so the
-- cap that bites here is the invoice's, not the payment's.

do $$
declare
  refused boolean := false;
begin
  begin
    insert into public.payment_allocations (payment_id, invoice_id, amount_pence, tenant_id)
    values ('f3333333-3333-3333-3333-333333333333', 'c1111111-1111-1111-1111-111111111111',
            100000, 'b1111111-1111-1111-1111-111111111111');
  exception when others then
    refused := true;
  end;

  if not refused then
    raise exception 'FAIL: allocations may exceed the invoice gross — £1,000.00 was allocated against a £1,000.00 invoice that already had £100.00 on it';
  end if;
  raise notice 'PASS A3: an allocation may not exceed the invoice gross';
end
$$;

-- ── A4. An allocation may not exceed the payment's amount ──────────────────
--
-- The payment is £1,000.00. The first allocation below spends all of it
-- against a £5,000.00 invoice, which is allowed: it is exactly the payment's
-- amount, not more. The second tries to spend it a second time against
-- another £5,000.00 invoice. Neither invoice is near its gross, so the only
-- cap that can refuse it is the payment's.

do $$
declare
  refused boolean := false;
begin
  insert into public.payment_allocations (payment_id, invoice_id, amount_pence, tenant_id)
  values ('f3333333-3333-3333-3333-333333333333', 'c2222222-2222-2222-2222-222222222222',
          100000, 'b1111111-1111-1111-1111-111111111111');

  begin
    insert into public.payment_allocations (payment_id, invoice_id, amount_pence, tenant_id)
    values ('f3333333-3333-3333-3333-333333333333', 'c3333333-3333-3333-3333-333333333333',
            100000, 'b1111111-1111-1111-1111-111111111111');
  exception when others then
    refused := true;
  end;

  if not refused then
    raise exception 'FAIL: allocations may exceed the payment amount — £1,000.00 was allocated twice from a £1,000.00 payment';
  end if;
  raise notice 'PASS A4: an allocation may not exceed the payment amount';
end
$$;

rollback;
