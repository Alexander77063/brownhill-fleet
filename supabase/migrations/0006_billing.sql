-- 0006 — billing & payments: rent schedule, invoices, payments, allocations
-- Invoices/rent represent what is DUE (accrual). Cash received lives in
-- `payments`; the VAT return and cash P&L derive only from payments (0011).

create table rent_schedule (
  id              uuid primary key default gen_random_uuid(),
  agreement_id    uuid not null references agreements(id) on delete cascade,
  week_no         int not null check (week_no >= 1),
  period_start    date not null,
  period_end      date not null,
  gross_due_pence bigint not null,
  net_due_pence   bigint not null,
  vat_due_pence   bigint not null,
  status          rent_status not null default 'due',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (agreement_id, week_no),
  check (period_end >= period_start)
);
create trigger trg_rent_updated before update on rent_schedule
  for each row execute function set_updated_at();
create index rent_agreement_idx on rent_schedule (agreement_id);
create index rent_status_idx on rent_schedule (status);

create table invoices (
  id               uuid primary key default gen_random_uuid(),
  agreement_id     uuid not null references agreements(id) on delete cascade,
  rent_schedule_id uuid references rent_schedule(id) on delete set null,
  number           text unique,
  issued_on        date not null default current_date,
  due_on           date not null,
  gross_pence      bigint not null check (gross_pence >= 0),
  net_pence        bigint not null check (net_pence  >= 0),
  vat_pence        bigint not null check (vat_pence  >= 0),
  status           invoice_status not null default 'open',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (gross_pence = net_pence + vat_pence)
);
create trigger trg_invoices_updated before update on invoices
  for each row execute function set_updated_at();
create index invoices_agreement_idx on invoices (agreement_id);
create index invoices_status_idx on invoices (status);

-- Payments are idempotent on (source, idempotency_key) so a provider webhook
-- and a manual bank entry can never double-count the same money.
create table payments (
  id              uuid primary key default gen_random_uuid(),
  driver_id       uuid references drivers(id),
  agreement_id    uuid references agreements(id),
  source          payment_source not null,
  idempotency_key text not null,
  amount_pence    bigint not null check (amount_pence > 0),  -- gross received
  received_on     date not null default current_date,
  status          payment_status not null default 'confirmed',
  external_ref    text,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  unique (source, idempotency_key)
);
create index payments_agreement_idx on payments (agreement_id);
create index payments_received_idx on payments (received_on);

create table payment_allocations (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid not null references payments(id) on delete cascade,
  invoice_id   uuid not null references invoices(id) on delete cascade,
  amount_pence bigint not null check (amount_pence > 0),
  created_at   timestamptz not null default now(),
  unique (payment_id, invoice_id)
);
create index alloc_invoice_idx on payment_allocations (invoice_id);

-- Guard: allocations may never exceed the payment amount or the invoice gross.
create or replace function check_allocation()
returns trigger language plpgsql as $$
declare
  pay_total bigint;
  pay_amt   bigint;
  inv_alloc bigint;
  inv_gross bigint;
begin
  select coalesce(sum(amount_pence),0) into pay_total
    from payment_allocations where payment_id = new.payment_id;
  select amount_pence into pay_amt from payments where id = new.payment_id;
  if pay_total > pay_amt then
    raise exception 'allocations (%.2f) exceed payment amount (%.2f)',
      pay_total/100.0, pay_amt/100.0;
  end if;

  select coalesce(sum(amount_pence),0) into inv_alloc
    from payment_allocations where invoice_id = new.invoice_id;
  select gross_pence into inv_gross from invoices where id = new.invoice_id;
  if inv_alloc > inv_gross then
    raise exception 'allocations (%.2f) exceed invoice gross (%.2f)',
      inv_alloc/100.0, inv_gross/100.0;
  end if;
  return new;
end;
$$;
create trigger trg_check_allocation
  after insert or update on payment_allocations
  for each row execute function check_allocation();

-- Keep invoice.status in sync with how much has been allocated to it.
create or replace function sync_invoice_status()
returns trigger language plpgsql as $$
declare
  inv_id uuid := coalesce(new.invoice_id, old.invoice_id);
  allocated bigint;
  gross bigint;
begin
  select coalesce(sum(amount_pence),0) into allocated
    from payment_allocations where invoice_id = inv_id;
  select gross_pence into gross from invoices where id = inv_id;
  update invoices set status =
    (case
      when allocated = 0 then 'open'
      when allocated >= gross then 'paid'
      else 'part_paid'
    end)::invoice_status
  where id = inv_id and status <> 'void';
  return null;
end;
$$;
create trigger trg_sync_invoice_status
  after insert or delete or update on payment_allocations
  for each row execute function sync_invoice_status();
