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

\echo '--- K8. every invoice carries the VAT code its VAT implies'
--
-- `public.invoices.vat_code_id` existed since migration 0067 and NOTHING
-- EVER WROTE IT. The VAT return groups on it:
--
--   select vc.code, sum(i.net_pence), sum(i.vat_pence)
--     from public.invoices i
--     left join accounting.vat_codes vc on vc.id = i.vat_code_id
--    where i.status <> 'void'
--    group by vc.code
--
-- With the column null, `vc.code` was null for every invoice, so the grouped
-- rows never matched 'T1' or 'T0'. Box 1 -- the output VAT DUE to HMRC --
-- was permanently zero, while box 4 carried the whole of the sales net.
do $$
declare
  r record; uncoded int;
begin
  select count(*) into uncoded from invoices where vat_code_id is null;
  if uncoded <> 0 then
    raise exception 'FAIL: % invoice(s) still have no VAT code, so the VAT return cannot see them', uncoded;
  end if;

  for r in
    select i.number, i.vat_pence, vc.code
      from invoices i
      join accounting.vat_codes vc on vc.id = i.vat_code_id
     order by i.number
  loop
    if r.vat_pence = 0 then
      if r.code <> 'T0' then
        raise exception 'FAIL: the zero-rated invoice % carries the code %, expected T0', r.number, r.code;
      end if;
    elsif r.code <> 'T1' then
      raise exception 'FAIL: the standard-rated invoice % carries the code %, expected T1', r.number, r.code;
    end if;
  end loop;
  raise notice 'PASS K8: every invoice carries a VAT code, and the zero-rated one is T0';
end
$$;

\echo '--- K9. the three live invoices are posted and the void one is not'
do $$
declare
  n int;
begin
  select count(*) into n from invoices
   where number in ('BRH-BF-0001','BRH-BF-0002','BRH-BF-0003')
     and posted_journal_id is not null;
  if n <> 3 then
    raise exception 'FAIL: % of the 3 live invoices are posted, expected 3', n;
  end if;

  select count(*) into n from invoices
   where number = 'BRH-BF-0004' and posted_journal_id is not null;
  if n <> 0 then
    raise exception 'FAIL: the void invoice was posted to the ledger';
  end if;

  select count(*) into n
    from accounting.journal_entries je
    join invoices i on i.id = je.source_id
   where je.source_type = 'invoice' and i.number = 'BRH-BF-0004';
  if n <> 0 then
    raise exception 'FAIL: the void invoice has % journal entr(y/ies), expected none', n;
  end if;
  raise notice 'PASS K9: the three live invoices are posted and the void one is not';
end
$$;

\echo '--- K10. rule 1 posted exactly Dr 1100 / Cr 4000 / Cr 2200 -- and no VAT line when there is no VAT'
do $$
declare
  n int; d bigint; c bigint; v bigint;
begin
  select count(*) into n
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join invoices i on i.id = je.source_id
   where i.number = 'BRH-BF-0003';
  if n <> 2 then
    raise exception 'FAIL: the zero-rated invoice has % journal lines, expected 2 -- a VAT line would be zero on BOTH sides, which journal_lines forbids', n;
  end if;

  select count(*) into n
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join invoices i on i.id = je.source_id
   where i.number = 'BRH-BF-0003' and a.code = '2200';
  if n <> 0 then
    raise exception 'FAIL: the zero-rated invoice has a VAT Output line';
  end if;

  select count(*) into n
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join invoices i on i.id = je.source_id
   where i.number = 'BRH-BF-0001';
  if n <> 3 then
    raise exception 'FAIL: the standard-rated invoice has % journal lines, expected 3', n;
  end if;

  select l.debit_pence into d
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join invoices i on i.id = je.source_id
   where i.number = 'BRH-BF-0001' and a.code = '1100';
  select l.credit_pence into c
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join invoices i on i.id = je.source_id
   where i.number = 'BRH-BF-0001' and a.code = '4000';
  select l.credit_pence into v
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join invoices i on i.id = je.source_id
   where i.number = 'BRH-BF-0001' and a.code = '2200';
  if d is distinct from 102000 or c is distinct from 85000 or v is distinct from 17000 then
    raise exception 'FAIL: BRH-BF-0001 posted Dr 1100 % / Cr 4000 % / Cr 2200 %, expected 102000 / 85000 / 17000', d, c, v;
  end if;
  raise notice 'PASS K10: rule 1 posted Dr 1100 % / Cr 4000 % / Cr 2200 %, and the zero-rated invoice has no VAT line', d, c, v;
end
$$;

\echo '--- K11. only money that arrived is posted'
do $$
declare
  n int; d bigint; c bigint;
begin
  select count(*) into n from payments
   where idempotency_key = 'bf-gc-1' and posted_journal_id is not null;
  if n <> 1 then
    raise exception 'FAIL: the confirmed payment was not posted';
  end if;

  select count(*) into n from payments
   where idempotency_key in ('bf-gc-2','bf-gc-3') and posted_journal_id is not null;
  if n <> 0 then
    raise exception 'FAIL: % payment(s) that never arrived were posted', n;
  end if;

  select count(*) into n from accounting.journal_entries where source_type = 'payment';
  if n <> 1 then
    raise exception 'FAIL: % payment journal entries, expected 1', n;
  end if;

  select l.debit_pence into d
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join payments p on p.id = je.source_id
   where p.idempotency_key = 'bf-gc-1' and a.code = '1200';
  select l.credit_pence into c
    from accounting.journal_lines l
    join accounting.journal_entries je on je.id = l.journal_id
    join accounting.chart_of_accounts a on a.id = l.account_id
    join payments p on p.id = je.source_id
   where p.idempotency_key = 'bf-gc-1' and a.code = '1100';
  if d is distinct from 102000 or c is distinct from 102000 then
    raise exception 'FAIL: the payment posted Dr 1200 % / Cr 1100 %, expected 102000 / 102000', d, c;
  end if;
  raise notice 'PASS K11: the confirmed payment posted Dr 1200 % / Cr 1100 %; the pending and failed ones were not posted', d, c;
end
$$;

\echo '--- K12. every posting landed in the month its DOCUMENT belongs to'
--
-- Not the month the posting was made. A rent invoice raised on the 1st for a
-- week that began on the 28th of the month before belongs to the month
-- before, and that is where the operator''s VAT return and year-end accounts
-- look for it.
do $$
declare
  n int; y int; m int; wrong int;
begin
  select p.year, p.month into y, m
    from invoices i
    join accounting.journal_entries je on je.id = i.posted_journal_id
    join accounting.periods p on p.id = je.period_id
   where i.number = 'BRH-BF-0001';
  if y is distinct from 2026 or m is distinct from 4 then
    raise exception 'FAIL: the April invoice was posted into %-%', y, m;
  end if;

  select p.year, p.month into y, m
    from invoices i
    join accounting.journal_entries je on je.id = i.posted_journal_id
    join accounting.periods p on p.id = je.period_id
   where i.number = 'BRH-BF-0002';
  if y is distinct from 2026 or m is distinct from 5 then
    raise exception 'FAIL: the May invoice was posted into %-%', y, m;
  end if;

  select p.year, p.month into y, m
    from invoices i
    join accounting.journal_entries je on je.id = i.posted_journal_id
    join accounting.periods p on p.id = je.period_id
   where i.number = 'BRH-BF-0003';
  if y is distinct from 2026 or m is distinct from 6 then
    raise exception 'FAIL: the June invoice was posted into %-%', y, m;
  end if;

  select p.year, p.month into y, m
    from payments pm
    join accounting.journal_entries je on je.id = pm.posted_journal_id
    join accounting.periods p on p.id = je.period_id
   where pm.idempotency_key = 'bf-gc-1';
  if y is distinct from 2026 or m is distinct from 4 then
    raise exception 'FAIL: the April payment was posted into %-%', y, m;
  end if;

  select count(*) into wrong
    from accounting.journal_entries je
    join accounting.periods p on p.id = je.period_id
   where p.year  = extract(year  from current_date)::int
     and p.month = extract(month from current_date)::int;
  if wrong <> 0 then
    raise exception 'FAIL: % posting(s) landed in the current month rather than the document''s month', wrong;
  end if;
  raise notice 'PASS K12: every posting landed in the month its document belongs to, and none landed in the current month';
end
$$;

\echo '--- K13. the ledger balances'
do $$
declare
  n int; d bigint; c bigint;
begin
  select count(*) into n from (
    select je.id
      from accounting.journal_entries je
      left join accounting.journal_lines l on l.journal_id = je.id
     group by je.id
    having coalesce(sum(l.debit_pence),0) <> coalesce(sum(l.credit_pence),0)
  ) x;
  if n <> 0 then
    raise exception 'FAIL: % journal entr(y/ies) do not balance', n;
  end if;

  select coalesce(sum(debit_pence),0), coalesce(sum(credit_pence),0) into d, c
    from accounting.journal_lines;
  if d <> c then
    raise exception 'FAIL: the trial balance is out by % pence', d - c;
  end if;
  raise notice 'PASS K13: every entry balances and the trial balance is % / %', d, c;
end
$$;

\echo '--- K14. the trial balance says what the business actually did'
do $$
declare
  d bigint; c bigint;
begin
  select coalesce(sum(l.debit_pence),0), coalesce(sum(l.credit_pence),0) into d, c
    from accounting.journal_lines l join accounting.chart_of_accounts a on a.id = l.account_id
   where a.code = '1100';
  if d <> 286500 or c <> 102000 then
    raise exception 'FAIL: Trade Debtors is Dr % / Cr %, expected Dr 286500 / Cr 102000', d, c;
  end if;

  select coalesce(sum(l.debit_pence),0), coalesce(sum(l.credit_pence),0) into d, c
    from accounting.journal_lines l join accounting.chart_of_accounts a on a.id = l.account_id
   where a.code = '1200';
  if d <> 102000 or c <> 0 then
    raise exception 'FAIL: the Bank account is Dr % / Cr %, expected Dr 102000 / Cr 0', d, c;
  end if;

  select coalesce(sum(l.debit_pence),0), coalesce(sum(l.credit_pence),0) into d, c
    from accounting.journal_lines l join accounting.chart_of_accounts a on a.id = l.account_id
   where a.code = '4000';
  if d <> 0 or c <> 255750 then
    raise exception 'FAIL: Sales is Dr % / Cr %, expected Dr 0 / Cr 255750', d, c;
  end if;

  select coalesce(sum(l.debit_pence),0), coalesce(sum(l.credit_pence),0) into d, c
    from accounting.journal_lines l join accounting.chart_of_accounts a on a.id = l.account_id
   where a.code = '2200';
  if d <> 0 or c <> 30750 then
    raise exception 'FAIL: VAT Output is Dr % / Cr %, expected Dr 0 / Cr 30750', d, c;
  end if;

  raise notice 'PASS K14: Trade Debtors Dr 286500 / Cr 102000, Bank Dr 102000, Sales Cr 255750, VAT Output Cr 30750';
end
$$;

\echo '--- K15. the VAT return now sees the output VAT'
do $$
declare
  net bigint; vat bigint; n int;
  -- The two months are kept apart on purpose: one pair of variables would
  -- carry the June figures into a message that also talks about April, and
  -- the PASS line would then report the wrong April numbers while the
  -- assertion itself was still right.
  apr_net bigint; apr_vat bigint;
  jun_net bigint; jun_vat bigint;
begin
  select coalesce(sum(i.net_pence),0), coalesce(sum(i.vat_pence),0), count(*)
    into net, vat, n
    from invoices i
    join accounting.vat_codes vc on vc.id = i.vat_code_id
   where i.status <> 'void'
     and vc.code = 'T1'
     and date_trunc('month', i.issued_on::timestamp) = date_trunc('month', date '2026-04-01');
  if n <> 1 or net <> 85000 or vat <> 17000 then
    raise exception 'FAIL: the April VAT return sees % row(s) of T1 (net %, VAT %), expected 1 (net 85000, VAT 17000)', n, net, vat;
  end if;
  apr_net := net; apr_vat := vat;

  select coalesce(sum(i.net_pence),0), coalesce(sum(i.vat_pence),0), count(*)
    into net, vat, n
    from invoices i
    join accounting.vat_codes vc on vc.id = i.vat_code_id
   where i.status <> 'void'
     and vc.code = 'T0'
     and date_trunc('month', i.issued_on::timestamp) = date_trunc('month', date '2026-06-01');
  if n <> 1 or net <> 102000 or vat <> 0 then
    raise exception 'FAIL: the June VAT return sees % row(s) of T0 (net %, VAT %), expected 1 (net 102000, VAT 0)', n, net, vat;
  end if;
  jun_net := net; jun_vat := vat;

  raise notice 'PASS K15: April T1 net % VAT %, June T0 net % VAT %',
    apr_net, apr_vat, jun_net, jun_vat;
end
$$;

\echo '=== BACKFILL ASSERTIONS COMPLETE ==='
