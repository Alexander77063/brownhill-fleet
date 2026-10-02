-- 0007 — deposits ledger and RTB option-credit equity ledger

create table deposit_ledger (
  id           uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements(id) on delete cascade,
  event        deposit_event not null,
  amount_pence bigint not null check (amount_pence > 0),
  reason       text,
  occurred_on  date not null default current_date,
  created_at   timestamptz not null default now()
);
create index deposit_agreement_idx on deposit_ledger (agreement_id);

-- RTB driver equity accrues £162.50/week option credit plus the £5,000 deposit.
-- equity_total = cumulative_credit + deposit. One row per week.
create table rtb_equity_ledger (
  id                      uuid primary key default gen_random_uuid(),
  agreement_id            uuid not null references agreements(id) on delete cascade,
  week_no                 int not null check (week_no >= 0),
  credit_pence            bigint not null default 0 check (credit_pence >= 0),
  cumulative_credit_pence bigint not null check (cumulative_credit_pence >= 0),
  deposit_pence           bigint not null default 0 check (deposit_pence >= 0),
  equity_total_pence      bigint not null check (equity_total_pence >= 0),
  as_of                   date not null,
  created_at              timestamptz not null default now(),
  unique (agreement_id, week_no)
);
create index equity_agreement_idx on rtb_equity_ledger (agreement_id);
