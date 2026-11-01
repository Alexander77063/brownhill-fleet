-- 0086 — backfill the ledger from the invoices and payments that already exist
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Two automatic posting rules are named by the design spec:
--
--   Rule #1, invoice issued:   Dr Trade Debtors (1100) / Cr Revenue (4000) / Cr VAT Output (2200)
--   Rule #2, payment confirmed: Dr Bank (1200) / Cr Trade Debtors (1100)
--
-- `postInvoiceJournal` and `postPaymentJournal` existed. The balance trigger
-- existed. The reconciliation queue's "match" button posted rule #2 by hand.
-- And NOTHING posted rule #1 at all, and nothing posted rule #2 outside that
-- one button.
--
-- So a deployment that has been running has invoices it billed and payments it
-- took, and a trial balance that contains none of them. The operator's
-- accounts showed the handful of bank lines somebody had reconciled by hand
-- and nothing else — while the rent invoice register said the business had
-- taken £40,000 of rentals. The VAT return then reported £0 of output VAT
-- because `public.invoices.vat_code_id` had been null since migration 0067,
-- and the return groups on it.
--
-- The application is now wired to post both rules in the same transaction as
-- the document they belong to (src/lib/accounting/gl-posting.ts). That fixes
-- everything from now on. It does nothing for what has already happened, and
-- "from now on" is not an answer to "what did we take last quarter".
--
-- So this file backfills the history: every invoice that was issued and every
-- payment that was confirmed gets the ledger entry it should have had, in the
-- month the DOCUMENT belongs to, and the document is marked as posted.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- It does not respect a closed period. A closed month is a statement about
-- what has already happened, and this file is restoring what already
-- happened — refusing to write into a closed period would leave the ledger
-- permanently short of the business it did. The application's own guard
-- (`assertPeriodOpenForPosting`) still refuses every NEW posting into a closed
-- period; this is the one-off restoration of history, and it runs inside the
-- migration transaction, once.
--
-- It does not post a void invoice. A cancelled invoice has no revenue.
--
-- It does not post a payment that was never confirmed. A pending or failed
-- payment is money that did not arrive.
--
-- IT IS IDEMPOTENT
-- -----------------
-- Every document is written once: the journal's key is
-- (tenant_id, source_type, source_id), the document's `posted_journal_id` is
-- the guard, and a document whose entry already exists is left alone rather
-- than given a second set of lines. Running this file twice changes nothing
-- the second time — which matters because the migration runner records what
-- it has applied, but the migration is also replayed by the portability proof.
--
-- A MISSING ACCOUNT IS FATAL
-- --------------------------
-- If the chart of accounts does not name the account a posting needs, this
-- file raises and the whole migration rolls back. A partially-backfilled
-- ledger — some months posted, some not — is worse than a failed deploy,
-- because it looks right on the screen and is wrong in the totals.

-- ── the period a document belongs to ───────────────────────────────────────
-- Created on demand, exactly as the application does it when it posts.
--
-- The period's id is RETURNED, not written to an OUT parameter. An OUT
-- parameter is part of the function's identity, so this would be
-- accounting.ensure_period(uuid, integer, integer, uuid) and every call
-- would have to pass a fourth argument — the first version of this file
-- did, and the migration failed with
--
--   ERROR: function accounting.ensure_period(uuid, integer, integer, uuid)
--          does not exist
--
-- which is PostgreSQL saying "you called me with the wrong number of
-- arguments" in the least obvious words. Returning the id is also what the
-- application does (ensurePeriodRow returns the row).
create or replace function accounting.ensure_period(
  p_tenant uuid,
  p_year   int,
  p_month  int
) returns uuid
language plpgsql as $$
declare
  v_period uuid;
begin
  insert into accounting.periods (tenant_id, year, month)
  values (p_tenant, p_year, p_month)
  on conflict (tenant_id, year, month) do update set year = excluded.year
  returning id into v_period;

  return v_period;
end;
$$;

comment on function accounting.ensure_period(uuid, int, int) is
  'The accounting period for a tenant and month, created if it does not exist.';

-- ── the chart-of-accounts id a code names ───────────────────────────────────
-- A tenant's own account wins over the global one, which is the same rule
-- the application applies (src/lib/accounting/chart-of-accounts.ts).
create or replace function accounting.account_id(
  p_code   text,
  p_tenant uuid
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  select a.id into v_id
    from accounting.chart_of_accounts a
   where a.code = p_code
     and (a.tenant_id is null or a.tenant_id = p_tenant)
   order by a.tenant_id nulls last
   limit 1;

  if v_id is null then
    raise exception
      'chart of accounts: no account with code % for tenant % — the ledger cannot be backfilled',
      p_code, p_tenant;
  end if;

  return v_id;
end;
$$;

comment on function accounting.account_id(text, uuid) is
  'The id of the chart-of-accounts account a code names, the tenant''s own account preferred over the global one. Raises when the code names none.';

-- ── the bank account a payment landed in ───────────────────────────────────
-- The same three sources, in the same order, as the application
-- (resolveBankGlAccountId in src/lib/accounting/gl-posting.ts):
--
--   1. the bank account the payment was recorded against;
--   2. the tenant's default bank account;
--   3. the seeded 'Bank Account' (1200).
create or replace function accounting.payment_bank_account_id(
  p_tenant uuid,
  p_bank_account uuid
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  if p_bank_account is not null then
    select ba.gl_account_id into v_id
      from accounting.bank_accounts ba
     where ba.id = p_bank_account
       and (ba.tenant_id is null or ba.tenant_id = p_tenant);
  end if;

  if v_id is null then
    select ba.gl_account_id into v_id
      from accounting.tenant_accounting_settings s
      join accounting.bank_accounts ba on ba.id = s.default_bank_account_id
     where s.tenant_id = p_tenant;
  end if;

  if v_id is null then
    v_id := accounting.account_id('1200', p_tenant);
  end if;

  return v_id;
end;
$$;

comment on function accounting.payment_bank_account_id(uuid, uuid) is
  'The GL account a payment is banked into: the payment''s own bank account, else the tenant''s default, else the seeded 1200.';

-- ── the VAT code an invoice belongs to ──────────────────────────────────────
-- The rule the application applies (src/lib/accounting/vat-codes.ts):
-- VAT on the invoice means T1 (standard-rated), no VAT means T0 (zero-rated).
create or replace function accounting.invoice_vat_code_id(
  p_vat_pence bigint,
  p_tenant    uuid
) returns uuid
language plpgsql as $$
declare
  v_code text;
  v_id   uuid;
begin
  v_code := case when p_vat_pence = 0 then 'T0' else 'T1' end;

  select vc.id into v_id
    from accounting.vat_codes vc
   where vc.code = v_code
     and (vc.tenant_id is null or vc.tenant_id = p_tenant)
   order by vc.tenant_id nulls last
   limit 1;

  if v_id is null then
    raise exception
      'VAT codes: no code % for tenant % — the VAT return cannot see an invoice without one',
      v_code, p_tenant;
  end if;

  return v_id;
end;
$$;

comment on function accounting.invoice_vat_code_id(bigint, uuid) is
  'The id of the VAT code an invoice belongs to: T1 when it carries VAT, T0 when it does not.';

-- ── 1. the VAT code on every invoice that has none ─────────────────────────
--
-- `public.invoices.vat_code_id` existed since migration 0067 and nothing ever
-- wrote it. The VAT return groups on it:
--
--   select vc.code, sum(i.net_pence), sum(i.vat_pence)
--     from public.invoices i
--     left join accounting.vat_codes vc on vc.id = i.vat_code_id
--    where i.status <> 'void'
--    group by vc.code
--
-- With the column null, `vc.code` was null for every invoice, so the grouped
-- rows never matched 'T1' or 'T0'. Box 1 — the output VAT DUE to HMRC — was
-- permanently zero, while box 4 carried the whole of the sales net. The
-- return said "you owe no VAT" and "you sold £40,000 of rentals" in the same
-- breath.
--
-- A tenant's own code wins over the global one, and an invoice that already
-- carries a code keeps it: the operator may have overridden the inference.
update public.invoices i
   set vat_code_id = accounting.invoice_vat_code_id(i.vat_pence, i.tenant_id)
 where i.vat_code_id is null;

-- ── 2. rule #1: the ledger entry for every invoice issued ──────────────────
do $$
declare
  r         record;
  v_period  uuid;
  v_journal uuid;
  v_created boolean;
  v_ar      uuid;
  v_rev     uuid;
  v_vat     uuid;
  v_count   int := 0;
begin
  for r in
    select i.id, i.tenant_id, i.gross_pence, i.net_pence, i.vat_pence, i.issued_on
      from public.invoices i
     where i.posted_journal_id is null
       and i.status <> 'void'
       and i.gross_pence > 0
     order by i.tenant_id, i.issued_on, i.id
  loop
    -- The period is ASSIGNED, not performed-into. `PERFORM` cannot carry an
    -- INTO clause: PostgreSQL rejects `perform f(...) into v` with
    --
    --   ERROR:  query is SELECT INTO, but it should be plain SELECT
    --
    -- which is the same mistake twice in one file, and both of them would
    -- have been found only by running the migration against a database that
    -- actually has invoices in it.
    v_period := accounting.ensure_period(
      r.tenant_id,
      extract(year  from r.issued_on)::int,
      extract(month from r.issued_on)::int
    );

    insert into accounting.journal_entries
      (posted_at, period_id, description, source_type, source_id, posted_by_user_id, tenant_id)
    values (now(), v_period, 'Invoice ' || r.id::text || ' issued',
            'invoice'::accounting.journal_source_type, r.id, null, r.tenant_id)
    on conflict (tenant_id, source_type, source_id) do nothing
    returning id into v_journal;

    v_created := (v_journal is not null);

    if not v_created then
      -- The entry already exists (posted by the application, or by an earlier
      -- run of this file). Take its id rather than making a second one.
      select je.id into v_journal
        from accounting.journal_entries je
       where je.tenant_id = r.tenant_id
         and je.source_type = 'invoice'
         and je.source_id = r.id;
    end if;

    if v_journal is null then
      raise exception 'journal entry for invoice % could not be found or created', r.id;
    end if;

    -- The lines are written only into an entry that has none. An entry the
    -- application made already has its lines, and writing them again would
    -- double the revenue.
    if not exists (select 1 from accounting.journal_lines l where l.journal_id = v_journal) then
      v_ar  := accounting.account_id('1100', r.tenant_id);
      v_rev := accounting.account_id('4000', r.tenant_id);
      v_vat := accounting.account_id('2200', r.tenant_id);

      -- Dr Trade Debtors, for the gross.
      insert into accounting.journal_lines
        (journal_id, account_id, debit_pence, credit_pence, tenant_id, source_invoice_id)
      values (v_journal, v_ar, r.gross_pence, 0, r.tenant_id, r.id);

      -- Cr Revenue, for the net.
      if r.net_pence > 0 then
        insert into accounting.journal_lines
          (journal_id, account_id, debit_pence, credit_pence, tenant_id, source_invoice_id)
        values (v_journal, v_rev, 0, r.net_pence, r.tenant_id, r.id);
      end if;

      -- Cr VAT Output, for the VAT — and NOT when there is none.
      --
      -- `journal_lines` carries `check ((debit_pence > 0) <> (credit_pence > 0))`,
      -- so a line that is zero on BOTH sides is not a zero line — it is an
      -- ILLEGAL line, and it takes the whole entry down with it. A zero-rated
      -- invoice has no VAT line, and the entry still balances.
      if r.vat_pence > 0 then
        insert into accounting.journal_lines
          (journal_id, account_id, debit_pence, credit_pence, tenant_id, source_invoice_id)
        values (v_journal, v_vat, 0, r.vat_pence, r.tenant_id, r.id);
      end if;

      if v_created then
        insert into accounting.audit_log
          (user_id, action, entity, entity_id, after, tenant_id)
        values (null, 'journal_posted'::accounting.audit_action, 'journal_entry', v_journal,
                jsonb_build_object(
                  'sourceType', 'invoice',
                  'sourceId',   r.id::text,
                  'sumDebits',  r.gross_pence::text,
                  'sumCredits', (r.net_pence + r.vat_pence)::text
                ),
                r.tenant_id);
      end if;
    end if;

    update public.invoices
       set posted_journal_id = v_journal
     where id = r.id;

    v_count := v_count + 1;
  end loop;

  raise notice 'backfilled % invoice(s) into the ledger', v_count;
end;
$$;

-- ── 3. rule #2: the ledger entry for every payment confirmed ───────────────
do $$
declare
  r         record;
  v_period  uuid;
  v_journal uuid;
  v_created boolean;
  v_bank    uuid;
  v_ar      uuid;
  v_count   int := 0;
begin
  for r in
    select p.id, p.tenant_id, p.amount_pence, p.received_on, p.bank_account_id
      from public.payments p
     where p.posted_journal_id is null
       and p.status = 'confirmed'
       and p.amount_pence > 0
     order by p.tenant_id, p.received_on, p.id
  loop
    v_period := accounting.ensure_period(
      r.tenant_id,
      extract(year  from r.received_on)::int,
      extract(month from r.received_on)::int
    );

    insert into accounting.journal_entries
      (posted_at, period_id, description, source_type, source_id, posted_by_user_id, tenant_id)
    values (now(), v_period, 'Payment ' || r.id::text || ' confirmed',
            'payment'::accounting.journal_source_type, r.id, null, r.tenant_id)
    on conflict (tenant_id, source_type, source_id) do nothing
    returning id into v_journal;

    v_created := (v_journal is not null);

    if not v_created then
      select je.id into v_journal
        from accounting.journal_entries je
       where je.tenant_id = r.tenant_id
         and je.source_type = 'payment'
         and je.source_id = r.id;
    end if;

    if v_journal is null then
      raise exception 'journal entry for payment % could not be found or created', r.id;
    end if;

    if not exists (select 1 from accounting.journal_lines l where l.journal_id = v_journal) then
      v_bank := accounting.payment_bank_account_id(r.tenant_id, r.bank_account_id);
      v_ar   := accounting.account_id('1100', r.tenant_id);

      -- Dr Bank / Cr Trade Debtors.
      insert into accounting.journal_lines
        (journal_id, account_id, debit_pence, credit_pence, tenant_id, source_payment_id)
      values (v_journal, v_bank, r.amount_pence, 0, r.tenant_id, r.id);
      insert into accounting.journal_lines
        (journal_id, account_id, debit_pence, credit_pence, tenant_id, source_payment_id)
      values (v_journal, v_ar, 0, r.amount_pence, r.tenant_id, r.id);

      if v_created then
        insert into accounting.audit_log
          (user_id, action, entity, entity_id, after, tenant_id)
        values (null, 'journal_posted'::accounting.audit_action, 'journal_entry', v_journal,
                jsonb_build_object(
                  'sourceType', 'payment',
                  'sourceId',   r.id::text,
                  'sumDebits',  r.amount_pence::text,
                  'sumCredits', r.amount_pence::text
                ),
                r.tenant_id);
      end if;
    end if;

    update public.payments
       set posted_journal_id = v_journal
     where id = r.id;

    v_count := v_count + 1;
  end loop;

  raise notice 'backfilled % payment(s) into the ledger', v_count;
end;
$$;
