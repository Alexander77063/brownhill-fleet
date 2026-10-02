-- 0058 — Nigerian subscription tiers.
--
-- Nigeria is sold as a per-vehicle subscription in three tiers — Standard, Gold,
-- Platinum — monthly or annually. The catalogue from 0030 already models plans,
-- features and a tenant's subscription; what it lacked was three facts:
--
--   * which market a plan belongs to, so a Lagos tenant is never offered
--     Starter/Growth/Scale and a UK tenant never sees a naira price;
--   * whether a plan's price is per vehicle rather than per tenant;
--   * how many vehicles a subscription is billing for.
--
-- `region` is nullable with null meaning uk so the existing rows need no
-- backfill; `regionOf()` in src/lib/catalogue is the one place that resolves it.
-- `base_price_pence` keeps its name: it was always an integer of minor units,
-- and on ng that integer is kobo (see src/lib/money.ts).
alter table plans
  add column if not exists region text check (region in ('uk', 'ng')),
  add column if not exists per_vehicle boolean not null default false;

comment on column plans.base_price_pence is
  'Integer minor units of the plan''s region currency: pence for uk, kobo for ng. The column name predates ng.';
comment on column plans.region is
  'Which market this plan is sold in. null = uk (rows that predate regions).';
comment on column plans.per_vehicle is
  'True when base_price_pence is charged per billed vehicle rather than per tenant.';

-- Metered from the tenant's vehicles (status <> sold), never declared.
alter table tenant_subscription
  add column if not exists billed_vehicles int not null default 0
    constraint tenant_subscription_billed_vehicles_nonneg check (billed_vehicles >= 0);

-- The three tiers, monthly and annual. Prices are set in the platform console,
-- not here: a per-vehicle plan at 0 is "unpriced", the console shows it as such,
-- and no invoice may be raised against it. The tier contents below are the seed
-- default the user approved on 2026-09-03; the console owns them from here on,
-- which is why every insert is ON CONFLICT DO NOTHING.
insert into plans (key, name, description, base_price_pence, interval, region, per_vehicle, sort) values
  ('ng_standard_month',  'Standard',          'Fleet core, compliance, documents, phone tracking.',                          0, 'month', 'ng', true, 100),
  ('ng_standard_year',   'Standard (annual)', 'Standard, billed annually.',                                                  0, 'year',  'ng', true, 101),
  ('ng_gold_month',      'Gold',              'Standard plus fuel management, fitted GPS hardware, SMS and push alerts.',    0, 'month', 'ng', true, 110),
  ('ng_gold_year',       'Gold (annual)',     'Gold, billed annually.',                                                      0, 'year',  'ng', true, 111),
  ('ng_platinum_month',  'Platinum',          'Gold plus remote immobilisation, insurance claims, AI optimiser and reports.', 0, 'month', 'ng', true, 120),
  ('ng_platinum_year',   'Platinum (annual)', 'Platinum, billed annually.',                                                  0, 'year',  'ng', true, 121)
on conflict (key) do nothing;

with tier(key, features) as (
  values
    ('standard', array['fleet.core','compliance','documents','gps.phone','notifications.email']),
    ('gold',     array['fleet.core','compliance','documents','gps.phone','notifications.email',
                       'fuel','gps.hardware','notifications.sms','notifications.push']),
    ('platinum', array['fleet.core','compliance','documents','gps.phone','notifications.email',
                       'fuel','gps.hardware','notifications.sms','notifications.push',
                       'gps.immobilise','insurance.claims','ai.optimiser','reports.director'])
)
insert into plan_features (plan_id, feature_key)
select p.id, f
from tier t
join plans p on p.key in ('ng_' || t.key || '_month', 'ng_' || t.key || '_year')
cross join unnest(t.features) as f
on conflict do nothing;
