// src/app/ops/series/page.tsx
// Ops-facing list of recurring booking series with a "create new series"
// form. Each series materialises its next horizon into the bookings table
// on creation; pausing or cancelling just flips the series status.

import { PageHeader, Card, CardTitle, Button, Badge, EmptyState, Stat } from '@/components/ui';
import { Icon } from '@/components/icons';
import { formatDate } from '@/lib/display';
import { requireTenantContext } from '@/lib/auth/context';
import { listSeries, upcomingOccurrences, countActiveSeries } from '@/lib/queries-booking-series';
import { setSeriesStatus } from '@/lib/actions/booking-series';
import { CreateSeriesForm } from './CreateSeriesForm';
import { getDrivers, getVehicles } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  active: 'profit',
  paused: 'warn',
  cancelled: 'loss',
} as const;

export default async function OpsSeriesPage() {
  await requireTenantContext();
  const [series, drivers, vehicles, activeCount] = await Promise.all([
    listSeries(),
    getDrivers(),
    getVehicles(),
    countActiveSeries(),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Dispatch"
        title="Recurring bookings"
        subtitle="Define a weekly run (e.g. Mon/Wed/Fri school run, 08:00) and the system schedules the next month of bookings for you."
        actions={<Button href="/ops/bookings" variant="ghost" size="sm">All bookings <Icon name="chevron" className="h-4 w-4" /></Button>}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Active series" value={activeCount} className="reveal" />
        <Stat label="Total defined" value={series.length} className="reveal" />
      </section>

      <Card className="mt-5 max-w-3xl">
        <CardTitle>New series</CardTitle>
        <CreateSeriesForm drivers={drivers.map((d) => ({ id: d.id, full_name: d.full_name }))} vehicles={vehicles.map((v) => ({ id: v.id, registration: v.registration }))} />
      </Card>

      <section className="mt-6">
        <h2 className="mb-3 font-display text-xl text-cream">Defined series</h2>
        {series.length === 0 ? (
          <EmptyState title="No recurring series yet" hint="Define one above and the system will create the next 4 weeks of bookings for you." />
        ) : (
          <ul className="space-y-3">
            {series.map((s) => {
              const upcoming = upcomingOccurrences(s);
              return (
                <li key={s.id} className="rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                    <span className="text-cream">{s.pickup} → {s.dropoff}</span>
                    <span className="text-xs text-muted">
                      {s.startTime} · {prettyDays(s.daysOfWeek)}
                      {s.driverName && ` · ${s.driverName}`}
                      {s.vehicleReg && ` · ${s.vehicleReg}`}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Starts {formatDate(s.startDate)}
                    {s.endDate && ` · ends ${formatDate(s.endDate)}`}
                    {' · '}{upcoming.length} booking{upcoming.length === 1 ? '' : 's'} scheduled in next {s.horizonWeeks} weeks
                  </p>
                  {upcoming.length > 0 && (
                    <p className="mt-1 text-xs text-muted">
                      Next: {formatDate(upcoming[0])}{upcoming.length > 1 ? ` (+${upcoming.length - 1} more)` : ''}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.status !== 'paused' && s.status !== 'cancelled' && (
                      <form action={setSeriesStatus}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="to" value="paused" />
                        <Button type="submit" size="sm" variant="ghost">Pause</Button>
                      </form>
                    )}
                    {s.status === 'paused' && (
                      <form action={setSeriesStatus}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="to" value="active" />
                        <Button type="submit" size="sm" variant="outline">Resume</Button>
                      </form>
                    )}
                    {s.status !== 'cancelled' && (
                      <form action={setSeriesStatus}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="to" value="cancelled" />
                        <Button type="submit" size="sm" variant="ghost">Cancel</Button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function prettyDays(csv: string): string {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return csv.split(',').map((d) => labels[Number.parseInt(d, 10)] ?? '?').join('/');
}