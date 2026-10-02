-- 0061 — owner alerts, zones, monthly reports, requests to us, on-call, push.
--
-- The protection product is what happens between the owner and their vehicle
-- when they are not looking: an alert the moment it matters, a report once a
-- month, and a person at our end when they ask for help. None of that existed:
-- "alerts" were rows in the notifications delivery log with no vehicle, kind or
-- severity; there was no report artefact; and nothing could reach us except
-- email. Alerts get their own table because three readers (the owner feed, the
-- staff feed, the monthly report) query them by vehicle and kind.

create type alert_kind as enum ('speeding','night_movement','zone_exit','device_offline','immobilised','released');

create table vehicle_alerts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  vehicle_id    uuid not null references vehicles(id) on delete cascade,
  owner_id      uuid references vehicle_owners(id) on delete set null,
  kind          alert_kind not null,
  severity      text not null check (severity in ('info','warning','critical')),
  occurred_at   timestamptz not null,
  lat           double precision,
  lng           double precision,
  speed_kph     numeric,
  detail        jsonb not null default '{}'::jsonb,
  -- One alert per EPISODE, not per ping: the key names the episode (see
  -- src/lib/alerts/dedupe.ts) and the unique constraint makes the insert
  -- idempotent — a duplicate is not an error and sends nothing.
  dedupe_key    text not null,
  notified_sms_at  timestamptz,
  notified_push_at timestamptz,
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);
create index vehicle_alerts_owner_idx on vehicle_alerts (owner_id, occurred_at desc);
create index vehicle_alerts_vehicle_idx on vehicle_alerts (tenant_id, vehicle_id, occurred_at desc);

-- A home zone for an owner's vehicle. Deliberately NOT `geofences`: entering one
-- of those raises a charge, and a zone drawn to protect a car must never bill.
create table owner_zones (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  owner_id    uuid references vehicle_owners(id) on delete set null,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  radius_m    int not null default 500 check (radius_m between 50 and 50000),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index owner_zones_vehicle_idx on owner_zones (tenant_id, vehicle_id) where is_active;

-- The monthly report is a frozen snapshot: computed once, rendered from `data`
-- for ever after, so the numbers an owner was sent never drift.
create table owner_reports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  owner_id      uuid not null references vehicle_owners(id) on delete cascade,
  period        text not null check (period ~ '^\d{4}-\d{2}$'),
  generated_at  timestamptz not null default now(),
  data          jsonb not null,
  sent_sms_at   timestamptz,
  sent_email_at timestamptz,
  unique (owner_id, period)
);

-- "Ask for help." stolen / immobilise are emergencies and escalate; other is a
-- console queue item.
create table owner_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  owner_id        uuid references vehicle_owners(id) on delete set null,
  vehicle_id      uuid references vehicles(id) on delete set null,
  raised_by       uuid not null,
  raised_role     text not null check (raised_role in ('owner','ops')),
  kind            text not null check (kind in ('stolen','immobilise','other')),
  note            text,
  status          text not null default 'open' check (status in ('open','acknowledged','closed')),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  closed_by       uuid,
  closed_at       timestamptz,
  resolution      text,
  -- Escalation state: which round has run and when the next is due.
  escalation_round   int not null default 0,
  next_escalation_at timestamptz,
  created_at      timestamptz not null default now()
);
create index owner_requests_open_idx on owner_requests (status, next_escalation_at) where status = 'open';
create index owner_requests_owner_idx on owner_requests (owner_id, created_at desc);

-- Who at OUR end gets called. Platform-level, no tenant. Never through the API.
create table platform_oncall (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete set null,
  name       text not null,
  phone      text not null,
  priority   int not null default 1 check (priority between 1 and 10),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Web push subscriptions, one row per browser per user. Owners and platform
-- admins both use this; the payload sender picks by user id.
create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index push_subscriptions_user_idx on push_subscriptions (user_id);

-- Distance, trips and moving time for one vehicle over a period, from the
-- breadcrumb history. SQL because a month of hardware pings is far more than
-- the 500-point track helper returns.
--
-- A parked hardware tracker still heartbeats, and GPS jitter moves each
-- heartbeat a few metres, so a segment only counts as MOVING when its
-- displacement is at least 50 m. Distance and moving minutes are summed over
-- moving segments only; a trip is a run of moving segments, and a new trip
-- starts after 10 minutes without movement. The longest gap is between any
-- two consecutive pings (tracker silence), regardless of movement.
--
-- SECURITY DEFINER so the report cron can read history it does not own, which
-- is exactly why EXECUTE is revoked from the API roles below: an owner or a
-- tenant member must not be able to call it for an arbitrary vehicle id.
create or replace function vehicle_movement_summary(p_vehicle uuid, p_from timestamptz, p_to timestamptz)
returns table (distance_m numeric, trips int, moving_minutes int, pings int, longest_gap_minutes int)
language sql stable security definer set search_path = public as $$
  with pts as (
    select lat, lng, recorded_at,
           lag(lat) over w as plat, lag(lng) over w as plng, lag(recorded_at) over w as pat
    from vehicle_position_history
    where vehicle_id = p_vehicle and recorded_at >= p_from and recorded_at < p_to
    window w as (order by recorded_at)
  ),
  seg as (
    select
      recorded_at,
      case when plat is null then 0
           else 2 * 6371000 * asin(least(1, sqrt(
             sin(radians(lat - plat) / 2) ^ 2
             + cos(radians(plat)) * cos(radians(lat)) * sin(radians(lng - plng) / 2) ^ 2))) end as d,
      case when pat is null then null else extract(epoch from (recorded_at - pat)) / 60 end as gap_min
    from pts
  ),
  moving as (
    select recorded_at, d, gap_min,
           lag(recorded_at) over (order by recorded_at) as prev_moving_at
    from seg
    where d >= 50
  )
  select
    coalesce((select sum(d) from moving), 0)::numeric,
    coalesce((select count(*) from moving
              where prev_moving_at is null
                 or extract(epoch from (recorded_at - prev_moving_at)) / 60 > 10), 0)::int,
    coalesce((select sum(gap_min) from moving where gap_min <= 10), 0)::int,
    (select count(*) from seg)::int,
    coalesce((select max(gap_min) from seg), 0)::int;
$$;
revoke execute on function vehicle_movement_summary(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function vehicle_movement_summary(uuid, timestamptz, timestamptz) to service_role;

-- RLS ------------------------------------------------------------------------
alter table vehicle_alerts enable row level security;
create policy vehicle_alerts_iso on vehicle_alerts as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy vehicle_alerts_ops on vehicle_alerts for all to authenticated using (is_ops()) with check (is_ops());
-- Keyed on the alert's owner, not on who owns the vehicle today: a vehicle
-- reassigned to a new owner must not hand them the previous owner's history.
create policy vehicle_alerts_owner_select on vehicle_alerts for select to authenticated
  using (owner_id is not null and owner_id = current_vehicle_owner_id());

alter table owner_zones enable row level security;
create policy owner_zones_iso on owner_zones as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy owner_zones_ops on owner_zones for all to authenticated using (is_ops()) with check (is_ops());
create policy owner_zones_owner_select on owner_zones for select to authenticated
  using (owner_id is not null and owner_id = current_vehicle_owner_id());

alter table owner_reports enable row level security;
create policy owner_reports_iso on owner_reports as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy owner_reports_ops on owner_reports for select to authenticated using (is_ops());
create policy owner_reports_owner_select on owner_reports for select to authenticated using (owner_id = current_vehicle_owner_id());

alter table owner_requests enable row level security;
create policy owner_requests_iso on owner_requests as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy owner_requests_ops on owner_requests for all to authenticated using (is_ops()) with check (is_ops());
create policy owner_requests_owner_select on owner_requests for select to authenticated using (owner_id = current_vehicle_owner_id());
create policy owner_requests_owner_insert on owner_requests for insert to authenticated
  with check (owner_id = current_vehicle_owner_id() and raised_role = 'owner' and raised_by = current_app_user()
              and (vehicle_id is null or owns_vehicle(vehicle_id)));

alter table platform_oncall enable row level security;
revoke all on platform_oncall from anon, authenticated;

alter table push_subscriptions enable row level security;
create policy push_subscriptions_self on push_subscriptions for all to authenticated
  using (user_id = current_app_user()) with check (user_id = current_app_user());
