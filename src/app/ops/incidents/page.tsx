// src/app/ops/incidents/page.tsx
// Operator-facing queue of driver-submitted damage reports. Sorted
// major-first, then by report time. Per-row buttons drive the state
// machine in @/lib/driver/damage-report-status — only the buttons the
// current status allows are shown, so a one-line click can't put a row
// in a state the action would reject.

import { PageHeader, Card, CardTitle, Button, Badge, Table, Th, Td as TdComp, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { formatDate } from '@/lib/display';
import { requireTenantContext } from '@/lib/auth/context';
import { listOpenIncidents, listRecentIncidents, countOpenIncidents } from '@/lib/queries-ops-incidents';
import { setDamageReportStatus } from '@/lib/actions/ops-incidents';
import { nextAllowedStatuses, type DamageReportStatus } from '@/lib/driver/damage-report-status';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

const STATUS_TONE: Record<DamageReportStatus, 'warn' | 'loss' | 'neutral' | 'profit'> = {
  open: 'warn',
  reviewed: 'neutral',
  in_repair: 'loss',
  resolved: 'profit',
  rejected: 'loss',
};

export default async function OpsIncidentsPage() {
  await requireTenantContext();

  const [open, recent, openCount] = await Promise.all([
    listOpenIncidents(),
    listRecentIncidents(50),
    countOpenIncidents(),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Damage & incidents"
        subtitle="Reports the drivers have raised from the driver portal. Major issues go to the top of the queue."
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Card>
          <p className="eyebrow text-parchment">Open reports</p>
          <p className="mt-2 font-display text-3xl tnum text-cream">{openCount}</p>
          <p className="text-xs text-muted">awaiting office action</p>
        </Card>
      </section>

      <Card className="mt-5">
        <CardTitle>Open queue</CardTitle>
        {open.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing waiting. Clean board.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {open.map((r) => {
              const allowed = nextAllowedStatuses(r.status);
              return (
                <li key={r.id} className="rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
                    <Badge tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>
                    <span className="text-xs text-muted">
                      {formatDate(r.createdAt)} · {r.driverName} · {r.vehicleReg}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-cream">{r.description}</p>
                  {r.resolutionNotes && (
                    <p className="mt-1 text-xs text-muted">Office note: {r.resolutionNotes}</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {allowed.length === 0 ? (
                      <span className="text-xs text-muted">No further actions.</span>
                    ) : (
                      allowed.map((target) => (
                        <form action={setDamageReportStatus} key={target} className="inline-flex items-center gap-2">
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="to" value={target} />
                          <Button type="submit" size="sm" variant={target === 'rejected' ? 'ghost' : 'outline'}>
                            → {target.replace('_', ' ')}
                          </Button>
                        </form>
                      ))
                    )}
                    {r.photoPath && (
                      <a href={`/api/receipts/media/${encodeURIComponent(r.photoPath)}`} className="text-xs text-gold-bright hover:underline">
                        View photo →
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <section className="mt-6">
        <h2 className="mb-3 font-display text-xl text-cream">Recent (closed included)</h2>
        {recent.length === 0 ? (
          <EmptyState title="No reports yet" hint="Drivers will surface their damage reports here as they come in." />
        ) : (
          <Table caption="Recent reports">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Severity</Th>
                <Th>Driver</Th>
                <Th>Vehicle</Th>
                <Th>Status</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-t border-hair-soft">
                  <TdComp className="text-xs text-muted">{formatDate(r.createdAt)}</TdComp>
                  <TdComp><Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge></TdComp>
                  <TdComp>{r.driverName}</TdComp>
                  <TdComp className="font-mono">{r.vehicleReg}</TdComp>
                  <TdComp><Badge tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge></TdComp>
                  <TdComp className="max-w-md truncate text-cream">{r.description}</TdComp>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}

const SEVERITY_TONE: Record<'minor' | 'moderate' | 'major', 'warn' | 'loss' | 'neutral'> = {
  minor: 'neutral',
  moderate: 'warn',
  major: 'loss',
};