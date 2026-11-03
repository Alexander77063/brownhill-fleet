-- standalone/sql/void-balance-proof.sql
--
-- Proves that a voided invoice is worth nothing: it is not owed, it is not
-- overdue, it does not make an agreement's arrears go up, and it is not
-- charged to a driver at the payment checkout.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `public.invoice_status` has carried 'void' since migration 0001, and
-- migration 0082 made the database refuse an allocation to a voided invoice.
-- But the two views that say what a customer OWES never learned about it.
--
-- `v_invoice_balance` selected `i.*` with no status filter, and
-- `markInvoiceVoid` sets the status and touches nothing else — so a
-- voided invoice appeared in the view with its gross intact, and
-- `balance_pence` was `gross_pence - allocated_pence`: the FULL amount, for
-- an invoice that had been cancelled.
--
-- That number was money leaving a customer's account.
-- `src/app/api/payments/checkout/route.ts` sums `balance_pence` for the
-- agreement and hands the sum to GoCardless or Stripe as the amount to
-- CHARGE. A customer whose invoice had been cancelled was taken to a
-- payment page for money they did not owe. `v_agreement_arrears` summed the
-- same column, so the operator's arrears screen showed the cancelled work
-- as still owed.
--
-- The guarantee belongs in the DATABASE, where every reader meets it — the
-- checkout route, the arrears screen, the invoice lists, and the readers
-- that have not been written yet.
--
-- It ends in ROLLBACK, so it leaves no fixtures behind and can be run
-- repeatedly against the same database.
--
-- Run it with:
--   psql -v ON_ERROR_STOP=1 -f standalone/sql/void-balance-proof.sql
--
-- Each assertion gets its own invoice, so that one assertion cannot pass
-- because of another one's state. In particular the void test voids its own
-- invoice rather than a shared one: a voided invoice would make the
-- "still visible" assertion pass for the wrong reason.

\set ON_ERROR_STOP on

begin;

-- ── Fixtures ───────────────────────────────────────────────────────────────
--
-- tenant_id is supplied on every insert because migration 0052 removed the
-- transitional default: an insert that forgets it must fail loudly rather
-- than land in the wrong tenant's books.
--
-- The tenant is the one migration 0017 onboards every installation into —
-- the same row the billing allocation proof uses. The insert is here so the
-- proof is self-contained, and `on conflict (id) do nothing` makes it a
-- no-op where the migration has already created it. It is NOT a tenant of
-- this proof's own: `tenants.slug` is unique, so a slug of this proof's
-- invention would collide with anything else that wanted the same one.

insert into public.tenants (id, name, slug)
values ('b1111111-1111-1111-1111-111111111111', 'Elite Fleet Management',
        'elite-fleet-management')
on conflict (id) do nothing;

insert into public.vehicles
  (id, registration, vin, colour, model_year, co2_gkm, ev_range_miles,
   list_value_pence, status, acquired_on, tenant_id)
values
  ('d2111111-1111-1111-1111-111111111111', 'BX24 VBF', 'WDD2221761P222222',
   'Obsidian Black', 2024, 32, 65, 11700000, 'on_hire', '2024-01-15',
   'b1111111-1111-1111-1111-111111111111');

insert into public.drivers
  (id, full_name, email, phone, address, date_of_birth, status, tenant_id)
values
  ('d3111111-1111-1111-1111-111111111111', 'Void Proof Driver',
   'void.proof@brownhill.test', '+447700900004',
   '2 Void Mews, London W1', '1990-01-01', 'active',
   'b1111111-1111-1111-1111-111111111111');

insert into public.agreements
  (id, type, vehicle_id, driver_id, status, start_date,
   weekly_gross_pence, weekly_net_pence, weekly_vat_pence, deposit_pence,
   excess_mile_pence, tenant_id)
values
  ('d4111111-1111-1111-1111-111111111111', 'standard',
   'd2111111-1111-1111-1111-111111111111', 'd3111111-1111-1111-1111-111111111111',
   'active', current_date - 30, 100000, 83333, 16667, 0, 100,
   'b1111111-1111-1111-1111-111111111111');

-- Two invoices, both past their due date.
--
--   VBF-001  £1,000   the open one: £400 of it is paid, £600 is owed
--   VBF-002  £500    the one that gets voided
--
-- Both are overdue on purpose. An overdue void invoice is the case the
-- fix has to get right in BOTH directions: not owed, and not overdue.
insert into public.invoices
  (id, agreement_id, number, issued_on, due_on, gross_pence, net_pence, vat_pence,
   status, tenant_id)
values
  ('d5111111-1111-1111-1111-111111111111', 'd4111111-1111-1111-1111-111111111111',
   'VBF-001', current_date - 30, current_date - 10, 100000, 83333, 16667, 'open',
   'b1111111-1111-1111-1111-111111111111'),
  ('d6111111-1111-1111-1111-111111111111', 'd4111111-1111-1111-1111-111111111111',
   'VBF-002', current_date - 30, current_date - 10, 50000, 41667, 8333, 'open',
   'b1111111-1111-1111-1111-111111111111');

-- One payment of £400, against VBF-001 only.
--
-- VBF-002 gets no payment at all: a voided invoice that was never paid is
-- the case that costs a customer money, because there is no refund to
-- offset the balance. A voided invoice that WAS paid has a refund against
-- it, and its balance is zero either way.
insert into public.payments
  (id, driver_id, agreement_id, source, idempotency_key, amount_pence,
   received_on, status, external_ref, tenant_id)
values
  ('e1111111-1111-1111-1111-111111111111', 'd3111111-1111-1111-1111-111111111111',
   'd4111111-1111-1111-1111-111111111111', 'bank_transfer', 'proof-void-1',
   40000, current_date - 5, 'confirmed', 'proof-void-1',
   'b1111111-1111-1111-1111-111111111111');

insert into public.payment_allocations (payment_id, invoice_id, amount_pence, tenant_id)
values ('e1111111-1111-1111-1111-111111111111', 'd5111111-1111-1111-1111-111111111111',
        40000, 'b1111111-1111-1111-1111-111111111111');

-- Void VBF-002, the way the application does it: the status changes and
-- NOTHING ELSE does. The gross stays at £500.00, which is exactly why the
-- views had to learn about the status.
update public.invoices set status = 'void' where id = 'd6111111-1111-1111-1111-111111111111';

-- ── V1. An open invoice still carries its balance ───────────────────────────
--
-- The positive case, and it comes FIRST. A view that reported every balance
-- as zero would pass every assertion below, so the negative ones mean
-- nothing without this one.
--
-- VBF-001 is worth £1,000.00 and has £400.00 allocated to it, so £600.00 is
-- owed.

do $$
declare
  balance numeric;
begin
  select v.balance_pence into balance
    from public.v_invoice_balance v
   where v.id = 'd5111111-1111-1111-1111-111111111111';

  if balance is distinct from 60000 then
    raise exception 'FAIL V1: the open invoice carries a balance of % pence, expected 60000', balance;
  end if;
  raise notice 'PASS V1: an open invoice still carries its balance';
end
$$;

-- ── V2. A void invoice is worth nothing ────────────────────────────────────
--
-- The core of it. VBF-002 was cancelled and it was never paid, so it is
-- worth £0.00 — not £500.00.

do $$
declare
  balance numeric;
begin
  select v.balance_pence into balance
    from public.v_invoice_balance v
   where v.id = 'd6111111-1111-1111-1111-111111111111';

  if balance is distinct from 0 then
    raise exception 'FAIL V2: a voided invoice still carries a balance of % pence — it is still being charged for', balance;
  end if;
  raise notice 'PASS V2: a voided invoice is worth nothing';
end
$$;

-- ── V3. A void invoice is still VISIBLE ────────────────────────────────────
--
-- The fix must not be "hide the cancelled invoice". The operator has to be
-- able to see the document they cancelled, and the customer has to be able
-- to see it in their invoice list. It is worth nothing; it is not gone.

do $$
declare
  present integer;
begin
  select count(*) into present
    from public.v_invoice_balance v
   where v.id = 'd6111111-1111-1111-1111-111111111111'
     and v.status = 'void';

  if present <> 1 then
    raise exception 'FAIL V3: a voided invoice is not visible in the balance view — the cancelled document has been hidden';
  end if;
  raise notice 'PASS V3: a voided invoice is still visible';
end
$$;

-- ── V4. A void invoice is never overdue ────────────────────────────────────

do $$
declare
  overdue boolean;
begin
  select v.is_overdue into overdue
    from public.v_invoice_balance v
   where v.id = 'd6111111-1111-1111-1111-111111111111';

  if overdue is not false then
    raise exception 'FAIL V4: a voided invoice is flagged overdue — a cancelled document is chasing the customer';
  end if;
  raise notice 'PASS V4: a voided invoice is never overdue';
end
$$;

-- ── V5. An invoice past its due date IS overdue ────────────────────────────
--
-- The positive control for V4. VBF-001 is past its due date, so the column
-- has to say so; otherwise V4 would pass for a view that never flags
-- anything.

do $$
declare
  overdue boolean;
begin
  select v.is_overdue into overdue
    from public.v_invoice_balance v
   where v.id = 'd5111111-1111-1111-1111-111111111111';

  if overdue is not true then
    raise exception 'FAIL V5: an invoice past its due date is not flagged overdue';
  end if;
  raise notice 'PASS V5: an invoice past its due date is flagged overdue';
end
$$;

-- ── V6. The arrears of an agreement exclude the void invoice ───────────────
--
-- The operator's arrears screen. VBF-001 owes £600.00. VBF-002 was
-- cancelled and owes nothing, so the agreement owes £600.00 — not £1,100.00.

do $$
declare
  outstanding numeric;
begin
  select a.outstanding_pence into outstanding
    from public.v_agreement_arrears a
   where a.agreement_id = 'd4111111-1111-1111-1111-111111111111';

  if outstanding is distinct from 60000 then
    raise exception 'FAIL V6: the arrears of an agreement are % pence, expected 60000 — a voided invoice is still counted as owed', outstanding;
  end if;
  raise notice 'PASS V6: the arrears of an agreement exclude a voided invoice';
end
$$;

-- ── V7. The amount the driver would be CHARGED excludes the void invoice ──
--
-- This is the money. `src/app/api/payments/checkout/route.ts` runs exactly
-- this query and hands the answer to the payment provider as the amount to
-- take. A voided invoice in the sum means a customer is charged for work
-- that was cancelled.

do $$
declare
  chargeable numeric;
begin
  select coalesce(sum(v.balance_pence), 0) into chargeable
    from public.v_invoice_balance v
   where v.agreement_id = 'd4111111-1111-1111-1111-111111111111'
     and v.balance_pence > 0;

  if chargeable is distinct from 60000 then
    raise exception 'FAIL V7: the checkout would charge % pence, expected 60000 — a voided invoice is being charged for', chargeable;
  end if;
  raise notice 'PASS V7: the checkout does not charge for a voided invoice';
end
$$;

-- ── V8. The arrears row still adds up ─────────────────────────────────────
--
-- `outstanding_pence` is `billed_pence` minus `collected_pence`, and it has
-- to hold for the row to mean anything. A fix that dropped the void invoice
-- from `outstanding_pence` alone would leave the screen saying "billed
-- £1,500, outstanding £600" for a customer who was billed for one week and
-- had it cancelled — and that "£900" is exactly the cancelled invoice,
-- still sitting there.

do $$
declare
  billed numeric;
  collected numeric;
  outstanding numeric;
begin
  select a.billed_pence, a.collected_pence, a.outstanding_pence
    into billed, collected, outstanding
    from public.v_agreement_arrears a
   where a.agreement_id = 'd4111111-1111-1111-1111-111111111111';

  if outstanding is distinct from billed - collected then
    raise exception 'FAIL V8: the arrears row does not add up — billed % pence, collected % pence, outstanding % pence', billed, collected, outstanding;
  end if;
  raise notice 'PASS V8: the arrears row adds up (billed - collected = outstanding)';
end
$$;

rollback;
