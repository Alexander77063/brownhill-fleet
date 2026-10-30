-- 0077 — the rent-to-buy contract, written down on the agreement.
--
-- A rent-to-buy agreement has two faces. The rentee signs a MONTHLY
-- contract: a price, a deposit, a term, a monthly payment, the part of that
-- payment credited against the buyout, and the buyout price. The system bills
-- a WEEKLY stream from it.
--
-- Until now only the weekly side was stored (term_weeks, weekly gross/net/VAT,
-- option_credit_weekly_pence). The monthly contract had to be rebuilt from it
-- by division and rounding, the price the rentee agreed had to be guessed
-- from the car's list value, and the cost the deal was priced against was not
-- written down at all. The directors' report therefore reported figures that
-- could differ from the ones the operator saw on the calculator.
--
-- Every figure the calculator shows is now stored, so the report sums exactly
-- what was agreed. The weekly columns stay as they are — they are the billing,
-- and the invoice run reads them.
--
-- Existing rent-to-buy rows are backfilled from the weekly figures (the only
-- record of them that exists). The backfill is exact arithmetic, not a guess:
-- a term of 156 weeks is 36 months, and £1,020 a week over 156 weeks is £4,420
-- a month.

alter table agreements
  add column if not exists term_months                int,
  add column if not exists monthly_gross_pence        bigint,
  add column if not exists agreed_vehicle_price_pence  bigint,
  add column if not exists agreed_vehicle_cost_pence   bigint;

comment on column agreements.term_months is
  'Rent-to-buy: the monthly term the rentee signed (null for a standard rental).';
comment on column agreements.monthly_gross_pence is
  'Rent-to-buy: the monthly payment the rentee signed, VAT-inclusive.';
comment on column agreements.agreed_vehicle_price_pence is
  'Rent-to-buy: the price the rentee is buying the car at.';
comment on column agreements.agreed_vehicle_cost_pence is
  'Rent-to-buy: what the car cost Brownhill when the deal was priced.';

-- Backfill the monthly contract from the weekly billing.
--
-- 156 weeks is 36 months (156 * 12 / 52 = 36 exactly), and £1,020 a week over
-- 156 weeks is £159,120, which is £4,420 a month. The arithmetic is exact --
-- no rounding guess is involved beyond the cents of the weekly figure itself.
update agreements a
   set term_months = greatest(1, round(a.term_weeks::numeric * 12 / 52))::int,
       monthly_gross_pence = round(a.weekly_gross_pence::numeric * a.term_weeks
                                   / greatest(1, round(a.term_weeks::numeric * 12 / 52)))::bigint,
       agreed_vehicle_price_pence = v.list_value_pence
  from vehicles v
 where a.type = 'rtb'
   and a.term_weeks is not null
   and a.term_months is null
   and v.id = a.vehicle_id;

-- A rent-to-buy must carry the monthly contract. The cost is deliberately NOT
-- required: a car bought outright has no funder invoice, and the report falls
-- back to the list value and says so.
alter table agreements drop constraint if exists rtb_contract_fields;
alter table agreements add constraint rtb_contract_fields check (
  type <> 'rtb' or (term_months is not null and monthly_gross_pence is not null)
);

-- ── The investor's rent-to-buy book ─────────────────────────────────────────
--
-- Investors have no base-table access (0012): they read the PII-free
-- v_investor_* views, which run as the owner and carry their own role guard
-- and tenant filter. This is the rent-to-buy twin of v_investor_vehicle.
--
-- Figures, not names: the rentee's identity is not the investor's business.
-- The rates are not computed here — the app's engine computes them from these
-- figures, so an investor sees the same numbers the directors see.
create or replace view v_investor_rtb as
select
  a.id                             as agreement_id,
  a.vehicle_id,
  v.registration,
  a.status,
  a.start_date,
  a.term_weeks,
  a.term_months,
  a.monthly_gross_pence,
  a.weekly_gross_pence,
  a.weekly_net_pence,
  a.weekly_vat_pence,
  a.deposit_pence,
  a.option_credit_weekly_pence,
  a.agreed_residual_pence,
  a.agreed_vehicle_price_pence,
  v.list_value_pence,
  a.agreed_vehicle_cost_pence,
  case
    when a.agreed_vehicle_cost_pence is not null and a.agreed_vehicle_cost_pence > 0
      then a.agreed_vehicle_cost_pence
    when fa.cost_pence is not null and fa.cost_pence > 0
      then fa.cost_pence
    else v.list_value_pence
  end as car_cost_pence,
  case
    when a.agreed_vehicle_cost_pence is not null and a.agreed_vehicle_cost_pence > 0
      then 'deal'
    when fa.cost_pence is not null and fa.cost_pence > 0
      then 'funder'
    else 'list'
  end as cost_basis
from agreements a
  join vehicles v on v.id = a.vehicle_id
  left join lateral (
    select fa2.initial_rental_pence + coalesce(fa2.amount_financed_pence, 0) as cost_pence
      from finance_agreements fa2
     where fa2.vehicle_id = a.vehicle_id
     order by fa2.created_at desc
     limit 1
  ) fa on true
where a.type = 'rtb'
  and a.tenant_id in (
    select mem.tenant_id from tenant_memberships mem
     where mem.user_id = current_app_user() and mem.status = 'active'
  )
  and auth_role() in ('investor', 'ops');

grant select on v_investor_rtb to authenticated;
