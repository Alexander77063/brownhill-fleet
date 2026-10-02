-- 0062 — NG-2: pay-first subscription collection.
--
-- Decisions (user, 2026-09-05): no monthly billing (annual for fleets and
-- insurers, annual or six-monthly for individuals); nothing works until money
-- is received; hardware and installation are one-off items priced in the
-- console; nothing about pricing is hardcoded. Spec:
-- docs/superpowers/specs/2026-09-05-nigeria-ng2-subscription-collection-design.md
--
-- Every seed below is ON CONFLICT DO NOTHING: the console owns the catalogue
-- from the moment it exists, and re-running this file must never undo an
-- operator's edit. The two UPDATEs on the ng_* rows are a one-time policy
-- change (monthly off; annual rows batch their additions) and are written so
-- that a console that has since changed those rows is not touched again: they
-- key on the seed defaults.

-- ── Plans: a six-month term, an audience, and how additions are charged ──────
alter table plans drop constraint if exists plans_interval_check;
alter table plans add constraint plans_interval_check
  check (interval in ('month', 'half_year', 'year'));

alter table plans add column if not exists audience text not null default 'all'
  check (audience in ('all', 'business', 'individual'));
comment on column plans.audience is
  'Who may be put on this plan: business = dedicated instances (fleets, insurers); '
  'individual = the shared instance; all = both. Decided by the user 2026-09-05: '
  'business buys annual only; individuals choose annual or half-year.';

alter table plans add column if not exists additions_billing text not null default 'immediate'
  check (additions_billing in ('immediate', 'monthly_batch'));
comment on column plans.additions_billing is
  'immediate: a vehicle added mid-term raises its pro-rata invoice at once (individuals pay now). '
  'monthly_batch: additions accumulate into one pro-rata invoice on the batch day (B2B).';

-- Monthly is off, not gone: the console can switch it back on.
update plans set active = false
  where key in ('ng_standard_month', 'ng_gold_month', 'ng_platinum_month') and active = true;
update plans set audience = 'all', additions_billing = 'monthly_batch'
  where key in ('ng_standard_year', 'ng_gold_year', 'ng_platinum_year')
    and audience = 'all' and additions_billing = 'immediate';

insert into plans (key, name, description, base_price_pence, interval, region, per_vehicle, audience, additions_billing, sort)
values
  ('ng_standard_half', 'Standard (6 months)', 'Six-month term for individual owners', 0, 'half_year', 'ng', true, 'individual', 'immediate', 105),
  ('ng_gold_half',     'Gold (6 months)',     'Six-month term for individual owners', 0, 'half_year', 'ng', true, 'individual', 'immediate', 115),
  ('ng_platinum_half', 'Platinum (6 months)', 'Six-month term for individual owners', 0, 'half_year', 'ng', true, 'individual', 'immediate', 125)
on conflict (key) do nothing;

-- Half-year rows start with their tier's features; the console owns them from here.
insert into plan_features (plan_id, feature_key)
select h.id, pf.feature_key
from plans h
join plans y on y.key = replace(h.key, '_half', '_year')
join plan_features pf on pf.plan_id = y.id
where h.key in ('ng_standard_half', 'ng_gold_half', 'ng_platinum_half')
on conflict do nothing;

-- ── One-off items live in the addons catalogue ───────────────────────────────
alter table addons add column if not exists region text check (region in ('uk', 'ng'));
comment on column addons.region is 'Market the item is sold in. Null = uk, as on plans.';
alter table addons add column if not exists kind text not null default 'recurring'
  check (kind in ('recurring', 'one_off'));
comment on column addons.kind is
  'one_off items (hardware, installation, replacement) are invoiced once and never count as MRR.';

create table if not exists plan_one_offs (
  plan_id  uuid not null references plans(id) on delete cascade,
  addon_id uuid not null references addons(id) on delete cascade,
  primary key (plan_id, addon_id)
);
comment on table plan_one_offs is
  'One-off items charged per vehicle when a vehicle joins this plan (e.g. tracker device + '
  'installation on Gold). Console-managed; the seed below is the default.';
alter table plan_one_offs enable row level security;
create policy plan_one_offs_read on plan_one_offs for select to authenticated using (true);
create policy plan_one_offs_admin on plan_one_offs for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
grant select, insert, update, delete on plan_one_offs to authenticated;

insert into addons (key, name, description, feature_key, pricing_model, unit_price_pence, unit_cost_pence, deposit_pence, region, kind)
values
  ('ng_tracker_device',      'GPS tracker (device)',      'Supplied by us',                          'gps.hardware',   'per_device', 0, 0, 0, 'ng', 'one_off'),
  ('ng_tracker_install',     'GPS tracker installation',  'Fitting at the customer''s location',      'gps.hardware',   'per_device', 0, 0, 0, 'ng', 'one_off'),
  ('ng_tracker_replacement', 'GPS tracker replacement',   'Out-of-warranty or lost device',           'gps.hardware',   'per_device', 0, 0, 0, 'ng', 'one_off'),
  ('ng_immobiliser_device',  'Immobiliser (device)',      'Remote immobilisation relay',              'gps.immobilise', 'per_device', 0, 0, 0, 'ng', 'one_off'),
  ('ng_immobiliser_install', 'Immobiliser installation',  'Fitting alongside the tracker',            'gps.immobilise', 'per_device', 0, 0, 0, 'ng', 'one_off')
on conflict (key) do nothing;

insert into plan_one_offs (plan_id, addon_id)
select p.id, a.id
from plans p
join addons a on a.key = any(
  case
    when p.key like 'ng_gold_%'     then array['ng_tracker_device', 'ng_tracker_install']
    when p.key like 'ng_platinum_%' then array['ng_tracker_device', 'ng_tracker_install', 'ng_immobiliser_device', 'ng_immobiliser_install']
    else array[]::text[]
  end)
where p.key like 'ng_%'
on conflict do nothing;

-- ── Subscription: the status machine and the anniversary ─────────────────────
alter table tenant_subscription drop constraint if exists tenant_subscription_status_check;
alter table tenant_subscription add constraint tenant_subscription_status_check
  check (status in ('trialing', 'unpaid', 'active', 'past_due', 'suspended', 'cancelled'));
comment on column tenant_subscription.status is
  'trialing (uk only) | unpaid (ng: created, never paid) | active | past_due (anniversary passed, '
  'in grace, full service) | suspended (nothing but emergencies) | cancelled.';
alter table tenant_subscription
  add column if not exists anniversary_on date,
  add column if not exists current_period_start date,
  add column if not exists activated_at timestamptz,
  add column if not exists past_due_since date,
  add column if not exists suspended_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists pending_plan_id uuid references plans(id),
  add column if not exists billing_name text,
  add column if not exists billing_email citext,
  add column if not exists billing_phone text,
  add column if not exists billing_address text,
  add column if not exists customer_tin text;
comment on column tenant_subscription.anniversary_on is
  'The renewal date. Equals current_period_end; kept as a date because every rule in the ladder is a day count from it.';

-- ── Invoices, lines, payments, events ────────────────────────────────────────
create table if not exists subscription_invoices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  number        text not null unique,
  kind          text not null check (kind in ('initial', 'renewal', 'addition', 'upgrade', 'one_off')),
  status        text not null default 'issued'
                  check (status in ('draft', 'issued', 'part_paid', 'paid', 'overdue', 'void')),
  plan_id       uuid references plans(id),
  period_start  date,
  period_end    date,
  issued_on     date not null default current_date,
  due_on        date not null,
  currency      text not null,
  net_minor     bigint not null check (net_minor >= 0),
  vat_minor     bigint not null check (vat_minor >= 0),
  gross_minor   bigint not null check (gross_minor = net_minor + vat_minor),
  paid_minor    bigint not null default 0 check (paid_minor >= 0),
  wht_minor     bigint not null default 0 check (wht_minor >= 0),
  paid_at       timestamptz,
  voided_at     timestamptz,
  void_reason   text,
  issuer        jsonb not null default '{}'::jsonb,
  customer      jsonb not null default '{}'::jsonb,
  data          jsonb not null default '{}'::jsonb,
  pay_token     text not null unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table subscription_invoices is
  'Invoices WE issue to a tenant for its protection subscription. Distinct from `invoices`, which a '
  'tenant issues to its own drivers. `data` is the frozen render snapshot: the printable page reads only it.';
create trigger trg_subscription_invoices_updated before update on subscription_invoices
  for each row execute function set_updated_at();
create index subscription_invoices_tenant_idx on subscription_invoices (tenant_id, issued_on desc);
create index subscription_invoices_status_idx on subscription_invoices (status, due_on);

create table if not exists subscription_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  invoice_id    uuid not null references subscription_invoices(id) on delete cascade,
  kind          text not null check (kind in ('subscription', 'one_off', 'proration', 'credit')),
  description   text not null,
  plan_id       uuid references plans(id),
  addon_id      uuid references addons(id),
  vehicle_id    uuid references vehicles(id) on delete set null,
  quantity      int not null check (quantity > 0),
  unit_minor    bigint not null,
  net_minor     bigint not null,
  vat_rate      numeric(6,4) not null,
  vat_minor     bigint not null,
  gross_minor   bigint not null,
  period_start  date,
  period_end    date,
  sort          int not null default 0
);
create index subscription_invoice_lines_invoice_idx on subscription_invoice_lines (invoice_id, sort);
create index subscription_invoice_lines_vehicle_idx on subscription_invoice_lines (vehicle_id) where vehicle_id is not null;

create table if not exists subscription_payments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  invoice_id    uuid not null references subscription_invoices(id) on delete cascade,
  source        text not null check (source in ('paystack', 'flutterwave', 'bank_transfer', 'manual')),
  reference     text not null,
  amount_minor  bigint not null check (amount_minor > 0),
  currency      text not null,
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'failed', 'refunded')),
  received_on   date,
  confirmed_at  timestamptz,
  verified_by   uuid,
  external_ref  text,
  note          text,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  unique (source, reference)
);
comment on table subscription_payments is
  'Money against a subscription invoice. UNIQUE (source, reference) is the idempotency key: a replayed '
  'webhook, a second visit to the return URL and a re-entered transfer all land on the same row.';
create index subscription_payments_invoice_idx on subscription_payments (invoice_id);
create index subscription_payments_pending_idx on subscription_payments (status, created_at) where status = 'pending';

create table if not exists subscription_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  invoice_id  uuid references subscription_invoices(id) on delete cascade,
  kind        text not null,
  actor       text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index subscription_events_tenant_idx on subscription_events (tenant_id, created_at desc);

-- RLS: members read their own; writes only by the service role or a platform admin.
do $$
declare t text;
begin
  foreach t in array array['subscription_invoices', 'subscription_invoice_lines', 'subscription_payments', 'subscription_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_read on %I for select to authenticated using (is_tenant_member(tenant_id))', t, t);
    execute format('create policy %I_admin on %I for all to authenticated using (is_platform_admin()) with check (is_platform_admin())', t, t);
    execute format('create policy tenant_isolation on %I as restrictive to authenticated using (is_tenant_member(tenant_id) or is_platform_admin()) with check (is_tenant_member(tenant_id) or is_platform_admin())', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ── Platform settings (issuer, bank, dunning offsets) ────────────────────────
create table if not exists platform_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
comment on table platform_settings is
  'Console-managed operating settings: invoice issuer and bank details, grace/cancel days, reminder offsets, '
  'preferred gateway. Defaults live in src/lib/collection/settings-defaults.ts — the only place those numbers appear in code.';
alter table platform_settings enable row level security;
create policy platform_settings_admin on platform_settings for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
grant select, insert, update, delete on platform_settings to authenticated;

-- ── Platform-wide invoice numbering: SUB-2026-000001 ─────────────────────────
create table if not exists subscription_invoice_counters (
  year int primary key,
  last int not null default 0
);
alter table subscription_invoice_counters enable row level security;  -- no policies: service role only

create or replace function next_subscription_invoice_number()
  returns text language plpgsql security definer set search_path = public as $$
declare
  v_year int := extract(year from current_date)::int;
  v_last int;
begin
  insert into subscription_invoice_counters (year, last) values (v_year, 1)
  on conflict (year) do update set last = subscription_invoice_counters.last + 1
  returning last into v_last;
  return format('SUB-%s-%s', v_year, lpad(v_last::text, 6, '0'));
end $$;
revoke execute on function next_subscription_invoice_number() from public, anon, authenticated;
grant execute on function next_subscription_invoice_number() to service_role;

-- ── Dunning steps are recorded in the existing reminders table ───────────────
-- The NG-2 step names carry their console-configured offset (renewal_30,
-- overdue_7, …), so the closed list becomes a shape check: lower-case slug.
alter table subscription_reminders drop constraint if exists subscription_reminders_kind_check;
alter table subscription_reminders add constraint subscription_reminders_kind_check
  check (kind ~ '^[a-z][a-z0-9_]{1,40}$');
