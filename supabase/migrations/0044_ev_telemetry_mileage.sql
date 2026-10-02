-- 0044 — EV/telemetry capture (battery, range, odometer) + mileage-based service.
--
-- Devices can now report odometer, EV state-of-charge and remaining range with
-- each ping; the latest lands on vehicle_positions and the full trail on
-- vehicle_position_history. A per-vehicle mileage service interval lets the daily
-- reminder sweep nudge the operator when a vehicle is due a service by distance
-- (complementing the existing date-based service schedule).

alter table vehicle_positions
  add column if not exists odometer_miles integer,
  add column if not exists battery_pct numeric,
  add column if not exists range_miles integer;

alter table vehicle_position_history
  add column if not exists odometer_miles integer,
  add column if not exists battery_pct numeric,
  add column if not exists range_miles integer;

alter table vehicles
  add column if not exists service_interval_miles integer,   -- null = no mileage rule
  add column if not exists last_service_miles integer;        -- odometer at last service
