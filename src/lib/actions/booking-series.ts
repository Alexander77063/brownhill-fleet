'use server';

// src/lib/actions/booking-series.ts
// Ops actions on booking_series: create (which also materialises the next
// horizon of `bookings` rows), and status transitions (pause / resume /
// cancel). The validation + recurrence rule lives in
// @/lib/ops/booking-series so it's unit-testable.

import { revalidatePath } from 'next/cache';
import { localDb } from '@/lib/auth/local-store';
import { requireTenantContext } from '@/lib/auth/context';
import {
  validateSeriesInput,
  expandSeries,
  type SeriesValidationError,
  type DayOfWeek,
} from '@/lib/ops/booking-series';

export interface CreateSeriesResult {
  ok: boolean;
  message: string;
  errorCode?: SeriesValidationError;
}

function nextReference(prefix: string, existing: string[]): string {
  // Simple in-process counter: REF-1, REF-2, ... Operators can overwrite
  // in the existing bookings UI; this just needs to be unique inside the
  // materialised set.
  let n = 1;
  while (existing.includes(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export async function createBookingSeries(formData: FormData): Promise<CreateSeriesResult> {
  const ctx = await requireTenantContext();

  const pickup = String(formData.get('pickup') ?? '').trim();
  const dropoff = String(formData.get('dropoff') ?? '').trim();
  if (!pickup || !dropoff) {
    return { ok: false, message: 'Pickup and dropoff are required.' };
  }

  const startDate = String(formData.get('start_date') ?? '');
  const endDateRaw = String(formData.get('end_date') ?? '').trim();
  const endDate: string | null = endDateRaw === '' ? null : endDateRaw;

  const daysRaw = formData.getAll('days_of_week').map((v) => Number.parseInt(String(v), 10));
  const daysOfWeek: DayOfWeek[] = daysRaw.filter(
    (d): d is DayOfWeek => Number.isInteger(d) && d >= 0 && d <= 6,
  );

  const startTime = String(formData.get('start_time') ?? '');
  const horizonWeeksRaw = Number.parseInt(String(formData.get('horizon_weeks') ?? '4'), 10);
  const horizonWeeks = Number.isInteger(horizonWeeksRaw) ? horizonWeeksRaw : 4;

  const validation = validateSeriesInput({
    startDate,
    endDate,
    daysOfWeek,
    startTime,
    horizonWeeks,
  });
  if (validation) {
    return {
      ok: false,
      message: validation === 'days_empty' ? 'Pick at least one day of the week.'
        : validation === 'days_invalid' ? 'Day-of-week values must be 0..6.'
        : validation === 'range_invalid' ? 'End date must be on or after the start date.'
        : validation === 'time_invalid' ? 'Start time must be HH:MM (24h).'
        : 'Horizon weeks must be between 1 and 52.',
      errorCode: validation,
    };
  }

  const driverId = String(formData.get('driver_id') ?? '') || null;
  const vehicleId = String(formData.get('vehicle_id') ?? '') || null;
  const passengerName = String(formData.get('passenger_name') ?? '').trim() || null;
  const passengerPhone = String(formData.get('passenger_phone') ?? '').trim() || null;
  const fareRaw = String(formData.get('fare') ?? '').trim();
  const farePence = fareRaw === '' ? null : Math.round(Number.parseFloat(fareRaw) * 100);
  const notes = String(formData.get('notes') ?? '').trim() || null;

  const sql = await localDb();

  // Insert the series first.
  const seriesRows = (await sql`
    insert into booking_series
      (tenant_id, driver_id, vehicle_id, pickup, dropoff, start_time,
       fare_pence, notes, passenger_name, passenger_phone,
       days_of_week, start_date, end_date, horizon_weeks, status, created_by)
    values
      (${ctx.tenantId}::uuid, ${driverId}::uuid, ${vehicleId}::uuid,
       ${pickup}, ${dropoff}, ${startTime}::time,
       ${farePence} as bigint, ${notes}, ${passengerName}, ${passengerPhone},
       ${daysOfWeek as number[]}::int[], ${startDate}::date, ${endDate}::date,
       ${horizonWeeks}::int, 'active'::text, ${ctx.userId}::uuid)
    returning id
  `) as Array<{ id: string }>;
  const id = seriesRows[0]?.id;
  if (!id) return { ok: false, message: 'Could not create the series.' };

  // Materialise the next horizon of bookings.
  const dates = expandSeries({ startDate, endDate, daysOfWeek, horizonWeeks });
  for (const d of dates) {
    const ts = `${d}T${startTime}:00Z`;
    await sql`
      insert into bookings
        (tenant_id, reference, source, status, passenger_name, passenger_phone,
         pickup, dropoff, scheduled_at, vehicle_id, driver_id, fare_pence, notes,
         created_by)
      values
        (${ctx.tenantId}::uuid,
         ${nextReference('SER', [])},
         'series'::booking_source,
         'requested'::booking_status,
         ${passengerName}, ${passengerPhone},
         ${pickup}, ${dropoff}, ${ts}::timestamptz,
         ${vehicleId}::uuid, ${driverId}::uuid,
         ${farePence} as bigint, ${notes},
         ${ctx.userId}::uuid)
    `;
  }

  revalidatePath('/ops/series');
  revalidatePath('/ops/bookings');
  revalidatePath('/ops');
  return { ok: true, message: `Series created — ${dates.length} bookings scheduled.` };
}

export async function setSeriesStatus(formData: FormData): Promise<void> {
  await requireTenantContext();
  const id = String(formData.get('id') ?? '');
  const to = String(formData.get('to') ?? '');
  const allowed = new Set(['active', 'paused', 'cancelled']);
  if (!id) throw new Error('Missing series id.');
  if (!allowed.has(to)) throw new Error('Unknown target status.');

  const sql = await localDb();
  await sql`update booking_series set status = ${to} where id = ${id}::uuid`;

  // If we're pausing or cancelling, leave the already-materialised bookings
  // in place (ops may want to leave a few weeks of pending bookings visible
  // for context). Cancelling all forward child bookings is a follow-up.

  revalidatePath('/ops/series');
  revalidatePath('/ops');
}