-- hosted/tests/backfill-assert.sql — what 0077 must have done to existing data.
--
-- Run by hosted/tests/migrations-regression.sh against the `backfill`
-- database, after the pre-0077 fixture has been loaded and 0077 (and every
-- migration after it) has been applied.
--
-- The claim under test: "0077 backfills the monthly contract onto rent-to-buy
-- agreements that already exist, and the rtb_contract_fields CHECK it adds is
-- satisfied by that backfill."
--
-- Every assertion raises an exception on failure, so a wrong result fails the
-- run rather than printing a hopeful number.

\set ON_ERROR_STOP on

\echo '--- K1. the backfill reconstructed the monthly contract from the weekly billing'
do $$
declare
  r record;
begin
  select term_months, monthly_gross_pence into r from agreements
   where id = 'a1111111-1111-1111-1111-111111111111';
  if r.term_months is distinct from 36 then
    raise exception 'FAIL: term_months is %, expected 36 (156 weeks x 12 / 52)', r.term_months;
  end if;
  if r.monthly_gross_pence is distinct from 442000 then
    raise exception 'FAIL: monthly_gross_pence is %, expected 442000 (£1,020 x 156 / 36)', r.monthly_gross_pence;
  end if;
  raise notice 'PASS K1: backfilled term % months at % pence a month', r.term_months, r.monthly_gross_pence;
end
$$;

\echo '--- K2. the agreed price came from the car, and the cost was left for the report to fall back on'
do $$
declare
  p bigint; c bigint; lv bigint;
begin
  select agreed_vehicle_price_pence, agreed_vehicle_cost_pence into p, c
    from agreements where id = 'a1111111-1111-1111-1111-111111111111';
  select list_value_pence into lv from vehicles where id = '11111111-1111-1111-1111-111111111111';
  if p is distinct from lv then
    raise exception 'FAIL: agreed_vehicle_price_pence is %, expected the list value %', p, lv;
  end if;
  if c is not null then
    raise exception 'FAIL: agreed_vehicle_cost_pence is %, expected null — a car bought outright has no funder invoice', c;
  end if;
  raise notice 'PASS K2: agreed price % pence (the car''s list value), cost left null for the report to fall back on', p;
end
$$;

\echo '--- K3. the standard rental was not touched'
do $$
declare
  tm int; mg bigint; p bigint;
begin
  select term_months, monthly_gross_pence, agreed_vehicle_price_pence into tm, mg, p
    from agreements where id = 'a2222222-2222-2222-2222-222222222222';
  if tm is not null or mg is not null or p is not null then
    raise exception 'FAIL: the standard rental was given a rent-to-buy contract (term % monthly % price %)', tm, mg, p;
  end if;
  raise notice 'PASS K3: the standard rental carries no rent-to-buy contract';
end
$$;

\echo '--- K4. the CHECK was added AND validated against the rows already in the table'
do $$
declare
  v boolean; n int;
begin
  select convalidated into v from pg_constraint
   where conrelid = 'public.agreements'::regclass and conname = 'rtb_contract_fields';
  if not found then
    raise exception 'FAIL: rtb_contract_fields does not exist';
  end if;
  if v is not true then
    raise exception 'FAIL: rtb_contract_fields was added but not validated';
  end if;
  select count(*) into n from agreements
   where type = 'rtb' and (term_months is null or monthly_gross_pence is null);
  if n <> 0 then
    raise exception 'FAIL: % rent-to-buy agreements still have no monthly contract', n;
  end if;
  raise notice 'PASS K4: rtb_contract_fields is in force and validated; no rent-to-buy row lacks a monthly contract';
end
$$;

\echo '--- K5. the backfill is idempotent — running it again changes nothing'
do $$
declare
  before_term int; before_monthly bigint; after_term int; after_monthly bigint;
begin
  select term_months, monthly_gross_pence into before_term, before_monthly
    from agreements where id = 'a1111111-1111-1111-1111-111111111111';

  -- The backfill statement exactly as 0077 writes it, run a second time.
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

  select term_months, monthly_gross_pence into after_term, after_monthly
    from agreements where id = 'a1111111-1111-1111-1111-111111111111';

  if after_term is distinct from before_term or after_monthly is distinct from before_monthly then
    raise exception 'FAIL: a second run of the backfill changed the row (%/% -> %/%)',
      before_term, before_monthly, after_term, after_monthly;
  end if;
  raise notice 'PASS K5: the backfill is idempotent (term % months, monthly % pence, unchanged)', after_term, after_monthly;
end
$$;

\echo '--- K6. an investor session reads the backfilled row through the view'
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000000-0000-4000-8000-000000000001','investor@backfill.test','{"role":"investor","full_name":"Backfill Investor"}'::jsonb)
on conflict (id) do nothing;

insert into tenant_memberships (tenant_id, user_id, role, status) values
  ('b1111111-1111-1111-1111-111111111111','c0000000-0000-4000-8000-000000000001','investor','active')
on conflict (tenant_id, user_id) do nothing;

select set_config('app.user_id', 'c0000000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  n int; months int; monthly bigint; price bigint; basis text;
begin
  -- The view is owned by the migration owner, so as the superuser this would
  -- pass without proving anything. The role switch is what makes it a test.
  if current_user <> 'authenticated' then
    raise exception 'FAIL: the role switch did not take effect (current_user is %)', current_user;
  end if;
  select count(*) into n from v_investor_rtb;
  if n <> 1 then
    raise exception 'FAIL: the investor saw % rows of v_investor_rtb, expected 1', n;
  end if;
  select term_months, monthly_gross_pence, agreed_vehicle_price_pence, cost_basis
    into months, monthly, price, basis from v_investor_rtb
   where agreement_id = 'a1111111-1111-1111-1111-111111111111';
  if months is distinct from 36 or monthly is distinct from 442000 then
    raise exception 'FAIL: the investor sees % months at % pence, expected 36 at 442000', months, monthly;
  end if;
  if price is distinct from 11700000 then
    raise exception 'FAIL: the investor sees price %, expected 11700000', price;
  end if;
  raise notice 'PASS K6: the investor reads the backfilled deal — % months, % pence a month, price % pence, cost basis %',
    months, monthly, price, basis;
end
$$;
reset role;

\echo '--- K7. a director invited under a tenant role lands in the governance portal'
do $$
declare
  u uuid := 'c0000000-0000-4000-8000-000000000002';
  got text;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (u, 'director@backfill.test', jsonb_build_object('role','director_exec','full_name','Backfill Director'))
  on conflict (id) do nothing;
  select p.role::text into got from profiles p where p.id = u;
  if got is distinct from 'accounts' then
    raise exception 'FAIL: a director_exec signup landed in the % portal, expected accounts', got;
  end if;
  raise notice 'PASS K7: a director_exec signup creates a profile in the % portal', got;
end
$$;

\echo '=== BACKFILL ASSERTIONS COMPLETE ==='
