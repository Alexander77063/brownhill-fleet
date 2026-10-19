// src/lib/queries-booking-series.ts
// Ops-side reads of booking_series. /ops/series lists active/paused series
// with their next-generated dates, and /ops/series/[id] is the per-row
// view + status-change form.

import { localDb } from '@/lib/auth/local-store';
import { expandSeries } from './ops/booking-series';

export type SeriesStatus = 'active' | 'paused' | 'cancelled';

export interface BookingSeriesRow {
  id: string;
  driverId: string | null;
  driverName: string | null;
  vehicleId: string | null;
  vehicleReg: string | null;
  pickup: string;
  dropoff: string;
  startTime: string;
  farePence: number | null;
  passengerName: string | null;
  daysOfWeek: string;
  startDate: string;
  endDate: string | null;
  horizonWeeks: number;
  status: SeriesStatus;
  createdAt: string;
}

interface RawRow {
  id: string;
  driver_id: string | null;
  driver_name: string | null;
  vehicle_id: string | null;
  vehicle_reg: string | null;
  pickup: string;
  dropoff: string;
  start_time: string;
  fare_pence: string | null;
  passenger_name: string | null;
  days_of_week: number[];
  start_date: string;
  end_date: string | null;
  horizon_weeks: number;
  status: SeriesStatus;
  created_at: string;
}

export async function listSeries(opts?: { status?: SeriesStatus }): Promise<BookingSeriesRow[]> {
  const sql = await localDb();
  const rows = (await sql`
    select s.id, s.driver_id, d.full_name as driver_name,
           s.vehicle_id, v.registration as vehicle_reg,
           s.pickup, s.dropoff, s.start_time, s.fare_pence, s.passenger_name,
           s.days_of_week, s.start_date, s.end_date, s.horizon_weeks,
           s.status, s.created_at
      from booking_series s
      left join drivers  d on d.id = s.driver_id
      left join vehicles v on v.id = s.vehicle_id
     where (${opts?.status ?? null}::text is null or s.status = ${opts?.status ?? null}::text)
     order by s.created_at desc
  `) as RawRow[];
  return rows.map((r) => ({
    id: r.id,
    driverId: r.driver_id,
    driverName: r.driver_name,
    vehicleId: r.vehicle_id,
    vehicleReg: r.vehicle_reg,
    pickup: r.pickup,
    dropoff: r.dropoff,
    startTime: r.start_time,
    farePence: r.fare_pence !== null ? Number(r.fare_pence) : null,
    passengerName: r.passenger_name,
    daysOfWeek: r.days_of_week.join(','),
    startDate: r.start_date,
    endDate: r.end_date,
    horizonWeeks: r.horizon_weeks,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/** Materialise a series into future booking dates using its stored days_of_week + horizon. */
export function upcomingOccurrences(r: Pick<BookingSeriesRow, 'startDate' | 'endDate' | 'daysOfWeek' | 'horizonWeeks'>): string[] {
  const days = r.daysOfWeek.split(',').map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n));
  return expandSeries({
    startDate: r.startDate,
    endDate: r.endDate,
    daysOfWeek: days,
    horizonWeeks: r.horizonWeeks,
  });
}

export async function countActiveSeries(): Promise<number> {
  const sql = await localDb();
  const r = (await sql`select count(*)::int as n from booking_series where status = 'active'`) as Array<{ n: number }>;
  return r[0]?.n ?? 0;
}