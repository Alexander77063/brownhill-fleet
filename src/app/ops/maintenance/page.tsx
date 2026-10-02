import { PageHeader, Card, CardTitle, Stat, Badge, Money, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { getLookups } from '@/lib/queries';
import { getMaintenanceRecords, getVoidEvents } from '@/lib/queries-ops';
import { addMaintenance } from '@/lib/actions/ops';
import { getAuthContext } from '@/lib/auth/context';
import { listSchedules } from '@/lib/maintenance';
import { completeServiceAction, scheduleServiceAction } from '@/lib/actions/maintenance';
import { todayISO } from '@/lib/cron';
import { formatDate, titleCase } from '@/lib/display';

const ragTone = (r: string) => (r === 'red' ? 'loss' : r === 'amber' ? 'warn' : 'profit') as 'loss' | 'warn' | 'profit';
const inputCls = 'rounded-md border border-hair bg-[var(--surface)] px-2 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export const dynamic = 'force-dynamic';

export default async function MaintenancePage() {
  const ctx = await getAuthContext();
  const today = todayISO();
  const [records, voids, lookups, schedules] = await Promise.all([
    getMaintenanceRecords(),
    getVoidEvents(),
    getLookups(),
    ctx?.tenantId ? listSchedules(ctx.tenantId, today) : Promise.resolve([]),
  ]);
  const dueSoon = schedules.filter((s) => s.rag !== 'green').length;

  const cutoff = Date.now() - 365 * 86_400_000;
  const companyTrailing12m = records
    .filter((m) => m.payer === 'company' && new Date(m.service_on).getTime() >= cutoff)
    .reduce((s, m) => s + m.cost_pence, 0);
  const ongoingVoids = voids.filter((v) => !v.end_on).length;

  return (
    <>
      <PageHeader
        eyebrow="Maintenance"
        title="Maintenance & off-road"
        subtitle="Servicing history and void periods. Company-paid maintenance erodes margin on standard hires; on RTB the driver pays."
      />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Company-paid (12m)" value={<Money pence={companyTrailing12m} showPence={false} />} tone="loss" className="reveal" />
        <Stat label="Records" value={records.length} className="reveal" />
        <Stat label="Ongoing voids" value={ongoingVoids} tone={ongoingVoids > 0 ? 'warn' : 'profit'} className="reveal" />
        <Stat label="Services due/overdue" value={dueSoon} tone={dueSoon > 0 ? 'warn' : 'profit'} className="reveal" />
      </section>

      <section className="mt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl text-cream">Service schedule</h2>
          <form action={scheduleServiceAction} className="flex flex-wrap items-center gap-2">
            <select name="vehicle_id" required aria-label="Vehicle to schedule" className={inputCls}>
              <option value="">Vehicle…</option>
              {lookups.vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
            </select>
            <input name="kind" placeholder="service" defaultValue="service" required aria-label="Type of work" className={`${inputCls} w-28`} />
            <input name="interval_days" type="number" defaultValue={182} title="Interval (days)" aria-label="Interval in days" className={`${inputCls} w-20`} />
            <input name="next_due_on" type="date" required title="Next due" aria-label="Next due date" className={inputCls} />
            <Button type="submit" variant="outline" size="sm">Schedule</Button>
          </form>
        </div>
        {schedules.length === 0 ? (
          <EmptyState title="No schedules" hint="Schedule a service for a vehicle above." />
        ) : (
          <Table caption="Service schedule">
            <thead>
              <tr><Th>Vehicle</Th><Th>Work</Th><Th>Next due</Th><Th>Status</Th><Th>Mark done</Th></tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <Td className="text-cream">{s.registration ?? '—'}</Td>
                  <Td>{titleCase(s.kind)} <span className="text-muted">· {s.interval_days}d</span></Td>
                  <Td>{formatDate(s.next_due_on)}</Td>
                  <Td><Badge tone={ragTone(s.rag)}>{s.rag === 'red' ? 'Overdue' : s.rag === 'amber' ? 'Due soon' : 'OK'}</Badge></Td>
                  <Td>
                    <form action={completeServiceAction} className="flex items-center gap-1.5">
                      <input type="hidden" name="schedule_id" value={s.id} />
                      {/* One row per schedule, so the vehicle is part of each name. */}
                      <input name="done_on" type="date" defaultValue={today} aria-label={`Date completed for ${s.registration ?? 'vehicle'}`} className={inputCls} />
                      <input name="cost" placeholder="£ cost" aria-label={`Cost for ${s.registration ?? 'vehicle'}`} className={`${inputCls} w-20`} />
                      <select name="payer" aria-label={`Who pays for ${s.registration ?? 'vehicle'}`} className={inputCls}><option value="company">Company</option><option value="driver">Driver</option></select>
                      <Button type="submit" variant="ghost" size="sm">Done</Button>
                    </form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-3 font-display text-xl text-cream">Maintenance records</h2>
          {records.length === 0 ? (
            <EmptyState title="No maintenance recorded" />
          ) : (
            <Table caption="Maintenance records">
              <thead>
                <tr><Th>Date</Th><Th>Vehicle</Th><Th>Description</Th><Th>Payer</Th><Th className="text-right">Cost</Th></tr>
              </thead>
              <tbody>
                {records.map((m) => (
                  <tr key={m.id}>
                    <Td>{formatDate(m.service_on)}</Td>
                    <Td className="text-cream">{lookups.vehicleById.get(m.vehicle_id)?.registration ?? '—'}</Td>
                    <Td className="whitespace-normal">{m.description}</Td>
                    <Td><Badge tone={m.payer === 'company' ? 'loss' : 'neutral'}>{titleCase(m.payer)}</Badge></Td>
                    <Td className="text-right"><Money pence={m.cost_pence} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {/* Add maintenance */}
        <Card>
          <CardTitle>Add a record</CardTitle>
          <form action={addMaintenance} className="mt-4 space-y-3">
            <label className="block">
              <span className="eyebrow text-parchment">Vehicle</span>
              <select name="vehicle_id" required className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2">
                <option value="">Select vehicle…</option>
                {lookups.vehicles.map((v) => <option key={v.id} value={v.id}>{v.registration}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Description</span>
              <input name="description" required placeholder="Service & MOT" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2" />
            </label>
            <label className="block">
              <span className="eyebrow text-parchment">Payer</span>
              <select name="payer" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2">
                <option value="company">Company</option>
                <option value="driver">Driver</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="eyebrow text-parchment">Cost (£)</span>
                <input name="cost" type="number" step="0.01" min="0" placeholder="450.00" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream tnum focus-visible:outline-2" />
              </label>
              <label className="block">
                <span className="eyebrow text-parchment">Service on</span>
                <input name="service_on" type="date" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream focus-visible:outline-2" />
              </label>
            </div>
            <label className="block">
              <span className="eyebrow text-parchment">Odometer (miles)</span>
              <input name="odometer_miles" type="number" min="0" placeholder="12500" className="mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream tnum focus-visible:outline-2" />
            </label>
            <Button type="submit" className="w-full">Add record</Button>
          </form>
        </Card>
      </section>

      {/* Void events */}
      <section className="mt-4">
        <h2 className="mb-3 font-display text-xl text-cream">Off-road / void events</h2>
        {voids.length === 0 ? (
          <EmptyState title="No void events" />
        ) : (
          <Table caption="Off-road and void events">
            <thead>
              <tr><Th>Vehicle</Th><Th>From</Th><Th>To</Th><Th>Reason</Th></tr>
            </thead>
            <tbody>
              {voids.map((v) => (
                <tr key={v.id}>
                  <Td className="text-cream">{lookups.vehicleById.get(v.vehicle_id)?.registration ?? '—'}</Td>
                  <Td>{formatDate(v.start_on)}</Td>
                  <Td>{v.end_on ? formatDate(v.end_on) : <Badge tone="warn">Ongoing</Badge>}</Td>
                  <Td className="whitespace-normal">{v.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
