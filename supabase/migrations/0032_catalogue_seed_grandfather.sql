-- 0032 — default catalogue seed + grandfather (SP-A Task 5). Seeds a sensible
-- starting catalogue (4 base plans granting the CORE feature set that already
-- exists in Phases 1–3, plus the premium add-ons) and grandfathers every existing
-- tenant onto the top plan so NO live feature 403s the day entitlement-gating lands.
-- Idempotent (safe under `supabase db reset`). The operator refines prices/features
-- + wires Stripe from the platform console afterwards.

-- Base plans (prices are sensible defaults in pence; Stripe wiring is SP-A Task 6).
insert into plans (key, name, base_price_pence, interval, limits, sort) values
  ('trial',   'Trial',   0,     'month', '{"vehicles": 3}'::jsonb,   0),
  ('starter', 'Starter', 9900,  'month', '{"vehicles": 10}'::jsonb,  1),
  ('growth',  'Growth',  24900, 'month', '{"vehicles": 30}'::jsonb,  2),
  ('scale',   'Scale',   49900, 'month', '{"vehicles": 100}'::jsonb, 3)
on conflict (key) do nothing;

-- CORE features (everything already built) — granted by all base plans. Plans are
-- differentiated by limits + bundled add-ons; the premium capabilities are add-ons.
insert into plan_features (plan_id, feature_key)
select p.id, f.key
from plans p
cross join (values
  ('rental.core'), ('compliance'), ('documents'), ('contracts'),
  ('charges.reconciliation'), ('reports.director'), ('reports.investor'),
  ('notifications.email'), ('notifications.sms'), ('gps.phone'), ('booking.b2b')
) as f(key)
where p.key in ('trial', 'starter', 'growth', 'scale')
on conflict (plan_id, feature_key) do nothing;

-- Premium add-ons (prices left at 0 / inactive-by-default until the operator sets
-- them + wires Stripe). Device add-ons carry a refundable holding deposit.
insert into addons (key, name, feature_key, pricing_model, deposit_pence, active) values
  ('gps_hardware',       'GPS Hardware Tracking',   'gps.hardware',        'per_device',      20000, false),
  ('gps_immobilise',     'Vehicle Immobilisation',  'gps.immobilise',      'per_device',      0,     false),
  ('booking_b2c',        'Consumer Ride Booking',   'booking.b2c',         'flat',            0,     false),
  ('ai_optimiser',       'AI Optimiser',            'ai.optimiser',        'metered_per_unit', 0,    false),
  ('notifications_push', 'Push Notifications',      'notifications.push',  'flat',            0,     false)
on conflict (key) do nothing;

-- Grandfather every EXISTING tenant (those with no subscription yet) onto the top
-- plan so all their current features keep working. New tenants subscribe via
-- checkout and default to trial.
insert into tenant_subscription (tenant_id, plan_id, status)
select t.id, p.id, 'active'
from tenants t
cross join (select id from plans where key = 'scale') p
where not exists (select 1 from tenant_subscription ts where ts.tenant_id = t.id)
on conflict (tenant_id) do nothing;
