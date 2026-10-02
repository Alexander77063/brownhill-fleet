/**
 * Bookings & dispatch. A booking flows requested → assigned → en_route →
 * in_progress → completed (with cancel / no-show branches). Assignment links a
 * vehicle + driver and is BLOCKED if either is non-compliant (expired
 * MOT/insurance/PCO/DVLA/VED) — compliance enforced at the point of dispatch.
 */

import { createServiceClient } from '@/lib/supabase/server';
import { checkCompliance } from '@/lib/compliance';

export type BookingStatus =
  | 'requested'
  | 'assigned'
  | 'en_route'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show';

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  requested: ['assigned', 'cancelled'],
  assigned: ['en_route', 'cancelled', 'no_show'],
  en_route: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

type Sb = ReturnType<typeof createServiceClient>;

async function audit(sb: Sb, tenantId: string, action: string, bookingId: string, detail: Record<string, unknown>, actor?: string | null) {
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: action,
    p_entity_type: 'booking',
    p_entity_id: bookingId,
    p_detail: detail as never,
    p_actor: actor ?? undefined,
  });
}

export interface CreateBookingInput {
  source?: 'dispatch' | 'app' | 'job_sheet';
  passengerName?: string;
  passengerPhone?: string;
  pickup: string;
  dropoff: string;
  scheduledAt?: string;
  farePence?: number;
  notes?: string;
}

export async function createBooking(tenantId: string, input: CreateBookingInput, actor: string): Promise<{ id: string; reference: string }> {
  if (!input.pickup?.trim() || !input.dropoff?.trim()) throw new Error('Pickup and drop-off are required.');
  const sb = createServiceClient();
  const { data: refData, error: refErr } = await sb.rpc('next_ref', { p_tenant: tenantId, p_kind: 'BKG' });
  if (refErr || !refData) throw new Error(`Could not allocate reference: ${refErr?.message ?? 'none'}`);

  const { data: booking, error } = await sb
    .from('bookings')
    .insert({
      tenant_id: tenantId,
      reference: refData,
      source: input.source ?? 'dispatch',
      status: 'requested',
      passenger_name: input.passengerName ?? null,
      passenger_phone: input.passengerPhone ?? null,
      pickup: input.pickup.trim(),
      dropoff: input.dropoff.trim(),
      scheduled_at: input.scheduledAt || null,
      fare_pence: input.farePence ?? null,
      notes: input.notes ?? null,
      created_by: actor,
    } as never)
    .select('id')
    .single();
  if (error || !booking) throw new Error(`Could not create booking: ${error?.message ?? 'none'}`);
  await audit(sb, tenantId, 'booking.created', (booking as { id: string }).id, { reference: refData }, actor);
  return { id: (booking as { id: string }).id, reference: refData };
}

/** Assign a vehicle + driver, blocking if either is non-compliant. */
export async function assignBooking(tenantId: string, bookingId: string, vehicleId: string, driverId: string, actor: string): Promise<void> {
  const sb = createServiceClient();
  const { data: booking } = await sb.from('bookings').select('id, status').eq('id', bookingId).eq('tenant_id', tenantId).maybeSingle();
  if (!booking) throw new Error('Booking not found in this organisation.');
  if (!canTransition(booking.status as BookingStatus, 'assigned')) {
    throw new Error(`Cannot assign a booking that is "${booking.status}".`);
  }

  const { data: veh } = await sb.from('vehicles').select('id').eq('id', vehicleId).eq('tenant_id', tenantId).maybeSingle();
  if (!veh) throw new Error('Vehicle not found in this organisation.');
  const { data: drv } = await sb.from('drivers').select('id').eq('id', driverId).eq('tenant_id', tenantId).maybeSingle();
  if (!drv) throw new Error('Driver not found in this organisation.');

  const [vc, dc] = await Promise.all([checkCompliance('vehicle', vehicleId), checkCompliance('driver', driverId)]);
  const blockers = [...vc.blockers, ...dc.blockers];
  if (blockers.length > 0) {
    throw new Error(`Cannot assign — not roadworthy: ${blockers.map((b) => b.type).join(', ')}`);
  }

  const { error } = await sb
    .from('bookings')
    .update({ vehicle_id: vehicleId, driver_id: driverId, status: 'assigned' } as never)
    .eq('id', bookingId);
  if (error) throw new Error(`Could not assign: ${error.message}`);
  await audit(sb, tenantId, 'booking.assigned', bookingId, { vehicle_id: vehicleId, driver_id: driverId }, actor);
}

export async function transitionBooking(tenantId: string, bookingId: string, to: BookingStatus, actor: string): Promise<void> {
  const sb = createServiceClient();
  const { data: booking } = await sb.from('bookings').select('id, status').eq('id', bookingId).eq('tenant_id', tenantId).maybeSingle();
  if (!booking) throw new Error('Booking not found in this organisation.');
  if (!canTransition(booking.status as BookingStatus, to)) {
    throw new Error(`Cannot move a "${booking.status}" booking to "${to}".`);
  }
  const { error } = await sb.from('bookings').update({ status: to } as never).eq('id', bookingId);
  if (error) throw new Error(`Could not update booking: ${error.message}`);
  await audit(sb, tenantId, 'booking.status', bookingId, { to }, actor);
}

/**
 * Remove a booking.
 *
 * Deliberately conservative: only a booking still in `requested` is destroyed. Once a
 * booking has been assigned it has dispatch history — a vehicle and driver were
 * committed, compliance was checked, and it may be referenced by tracking/telematics
 * rows — so the correct outcome is `cancelled`, which is already a terminal state, not
 * deletion. Ops staff asking to "delete" a job in flight get the cancellation instead,
 * with a clear message.
 *
 * The audit entry is written BEFORE the row disappears, so the deletion is recoverable
 * as a fact even though the row is not.
 */
export async function deleteBooking(tenantId: string, bookingId: string, actor: string): Promise<void> {
  const sb = createServiceClient();
  const { data: booking } = await sb
    .from('bookings')
    .select('id, status, reference, pickup, dropoff, scheduled_at')
    .eq('id', bookingId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!booking) throw new Error('Booking not found in this organisation.');

  const row = booking as { id: string; status: string; reference: string; pickup: string; dropoff: string; scheduled_at: string | null };
  if (row.status !== 'requested') {
    throw new Error(
      `Only an unassigned booking can be deleted. "${row.reference}" is ${row.status} — cancel it instead so the dispatch history is kept.`,
    );
  }

  await audit(sb, tenantId, 'booking.deleted', bookingId, {
    reference: row.reference,
    pickup: row.pickup,
    dropoff: row.dropoff,
    scheduled_at: row.scheduled_at,
  }, actor);

  // Tenant-scoped on the delete itself, not just the lookup: a service-role client
  // bypasses RLS, so the filter is the only thing preventing a cross-tenant delete.
  const { error } = await sb.from('bookings').delete().eq('id', bookingId).eq('tenant_id', tenantId);
  if (error) throw new Error(`Could not delete booking: ${error.message}`);
}

export interface BookingRow {
  id: string;
  reference: string;
  status: string;
  source: string;
  pickup: string;
  dropoff: string;
  scheduled_at: string | null;
  passenger_name: string | null;
  vehicle: string | null;
  driver: string | null;
  fare_pence: number | null;
}

export async function listBookings(tenantId: string, limit = 100): Promise<BookingRow[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('bookings')
    .select('id, reference, status, source, pickup, dropoff, scheduled_at, passenger_name, fare_pence, vehicle_id, driver_id')
    .eq('tenant_id', tenantId)
    .order('scheduled_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  const rows = (data ?? []) as (Omit<BookingRow, 'vehicle' | 'driver'> & { vehicle_id: string | null; driver_id: string | null })[];
  if (rows.length === 0) return [];
  const [{ data: vehicles }, { data: drivers }] = await Promise.all([
    sb.from('vehicles').select('id, registration').in('id', rows.map((r) => r.vehicle_id).filter(Boolean) as string[]),
    sb.from('drivers').select('id, full_name').in('id', rows.map((r) => r.driver_id).filter(Boolean) as string[]),
  ]);
  const regs = new Map((vehicles ?? []).map((v) => [v.id, v.registration]));
  const names = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    source: r.source,
    pickup: r.pickup,
    dropoff: r.dropoff,
    scheduled_at: r.scheduled_at,
    passenger_name: r.passenger_name,
    vehicle: r.vehicle_id ? (regs.get(r.vehicle_id) ?? null) : null,
    driver: r.driver_id ? (names.get(r.driver_id) ?? null) : null,
    fare_pence: r.fare_pence,
  }));
}
