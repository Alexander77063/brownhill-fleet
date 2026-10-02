import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { getLookups } from '@/lib/queries';
import { getAuthContext } from '@/lib/auth/context';
import { listBookings } from '@/lib/bookings';
import { assignBookingAction, createBookingAction, deleteBookingAction, transitionBookingAction } from '@/lib/actions/bookings';
import { formatDate, titleCase } from '@/lib/display';

export const dynamic = 'force-dynamic';

const inputCls = 'rounded-md border border-hair bg-[var(--surface)] px-2 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

const STATUS_TONE: Record<string, 'gold' | 'profit' | 'loss' | 'neutral' | 'info'> = {
  requested: 'gold', assigned: 'info', en_route: 'info', in_progress: 'gold',
  completed: 'profit', cancelled: 'neutral', no_show: 'loss',
};
// Next actions offered per status. Mirrors the TRANSITIONS map in lib/bookings.ts —
// `cancelled` is now offered everywhere the state machine permits it, so an in-flight
// job can always be stood down (previously en_route/in_progress had no exit at all).
const NEXT: Record<string, string[]> = {
  assigned: ['en_route', 'no_show', 'cancelled'],
  en_route: ['in_progress', 'no_show', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
};

export default async function BookingsPage() {
  const ctx = await getAuthContext();
  const [lookups, bookings] = await Promise.all([
    getLookups(),
    ctx?.tenantId ? listBookings(ctx.tenantId) : Promise.resolve([]),
  ]);

  const active = bookings.filter((b) => !['completed', 'cancelled', 'no_show'].includes(b.status)).length;
  const unassigned = bookings.filter((b) => b.status === 'requested').length;

  return (
    <>
      <PageHeader eyebrow="Bookings" help="page.bookings" title="Dispatch" subtitle="Create jobs, assign a driver + vehicle, and track them to completion. Non-compliant vehicles/drivers can't be assigned." />

      {/* 2-up before `sm` — three across overflowed the page at 320px (WCAG 1.4.10). */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Active" value={active} className="reveal" />
        <Stat label="Unassigned" value={unassigned} tone={unassigned > 0 ? 'warn' : 'profit'} className="reveal" />
        <Stat label="Total" value={bookings.length} className="reveal" />
      </section>

      <section className="mt-4">
        <Card>
          <CardTitle>New booking</CardTitle>
          <form action={createBookingAction} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {/* This form is a compact placeholder-only grid. A placeholder is not an
                accessible name — it is not exposed by every AT and disappears on input —
                so each control carries an explicit aria-label (WCAG 4.1.2). */}
            <input name="pickup" required placeholder="Pickup" aria-label="Pickup" className={inputCls} />
            <input name="dropoff" required placeholder="Drop-off" aria-label="Drop-off" className={inputCls} />
            <input name="scheduled_at" type="datetime-local" title="When" aria-label="Scheduled for" className={inputCls} />
            <input name="passenger_name" placeholder="Passenger" aria-label="Passenger name" className={inputCls} />
            <input name="passenger_phone" placeholder="Phone" aria-label="Passenger phone" className={inputCls} />
            <input name="fare" placeholder="Fare £" aria-label="Fare in pounds" inputMode="decimal" className={inputCls} />
            <select name="source" aria-label="Booking source" className={inputCls}>
              <option value="dispatch">Dispatch</option>
              <option value="job_sheet">Job sheet</option>
              <option value="app">App</option>
            </select>
            <div className="sm:col-span-2 lg:col-span-3">
              <Button type="submit" variant="primary" size="sm">Create booking</Button>
            </div>
          </form>
        </Card>
      </section>

      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Jobs</h2>
        {bookings.length === 0 ? (
          <EmptyState title="No bookings yet" hint="Create a job above." />
        ) : (
          <Table caption="Jobs">
            <thead>
              <tr><Th>Ref</Th><Th>Route</Th><Th>When</Th><Th>Status</Th><Th>Driver / vehicle</Th><Th>Action</Th></tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <Td className="font-mono text-xs text-parchment">{b.reference}</Td>
                  <Td className="text-cream">{b.pickup} → {b.dropoff}</Td>
                  <Td>{b.scheduled_at ? formatDate(b.scheduled_at) : '—'}</Td>
                  <Td><Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{titleCase(b.status)}</Badge></Td>
                  <Td>{b.driver ? `${b.driver} · ${b.vehicle ?? '—'}` : '—'}</Td>
                  <Td>
                    {b.status === 'requested' ? (
                      <form action={assignBookingAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="booking_id" value={b.id} />
                        {/* Repeated once per row, so the booking reference is part of the
                            name — otherwise a screen reader hears "Driver" N times with no
                            way to tell which job is being assigned. */}
                        <select name="driver_id" required aria-label={`Assign driver to booking ${b.reference}`} className={inputCls}>
                          <option value="">Driver…</option>
                          {lookups.drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                        </select>
                        <select name="vehicle_id" required aria-label={`Assign vehicle to booking ${b.reference}`} className={inputCls}>
                          <option value="">Vehicle…</option>
                          {lookups.vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
                        </select>
                        <Button type="submit" variant="outline" size="sm">Assign</Button>
                      </form>
                    ) : null}
                    {b.status === 'requested' ? (
                      /* Only unassigned jobs can be deleted outright. Once assigned there
                         is dispatch history worth keeping, so the action becomes Cancel. */
                      <form action={deleteBookingAction} className="mt-1.5">
                        <input type="hidden" name="booking_id" value={b.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-[var(--color-loss)]">
                          Delete
                        </Button>
                      </form>
                    ) : NEXT[b.status] ? (
                      <div className="flex flex-wrap gap-1.5">
                        {NEXT[b.status].map((to) => (
                          <form key={to} action={transitionBookingAction}>
                            <input type="hidden" name="booking_id" value={b.id} />
                            <input type="hidden" name="to" value={to} />
                            <Button type="submit" variant="ghost" size="sm">{titleCase(to)}</Button>
                          </form>
                        ))}
                      </div>
                    ) : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
