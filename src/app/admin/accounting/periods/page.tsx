// src/app/admin/accounting/periods/page.tsx
// Owner-only period lifecycle: close a month at month-end, reopen within the
// 7-day grace window. Locking (the irreversible close) is not exposed here
// per spec §5 — the operator can run an SQL UPDATE on the live DB after the
// monthly close is final.
//
// Permission gate: tenant.settings (owner-side, full surface).
// Same reopen-window rule as /accounts/accounting/periods (reopenStatus in
// @/lib/accounting/periods) so the operator and the accountant see the same
// controls on the same period.

import { PageHeader, Card, CardTitle, Table, Th, Td, EmptyState, Button } from '@/components/ui';
import { formatDate } from '@/lib/display';
import { requirePermission } from '@/lib/auth/context';
import { listPeriods, REOPEN_WINDOW_DAYS, reopenStatus, reopenDeadline } from '@/lib/accounting/periods';
import { closePeriodAction, reopenPeriodAction } from '@/lib/actions/accounting-periods';

export const dynamic = 'force-dynamic';

export default async function AdminPeriodsPage() {
  // Belt + braces: the SaaS team's role-gate middleware handles the owner
  // claim. We re-gate here too because /admin/accounting/* lives at the
  // tenant-admin boundary.
  await requirePermission('tenant.settings');

  const periods = await listPeriods();
  const now = new Date();

  return (
    <main className="p-6">
      <div className="mb-2 text-xs uppercase tracking-wider text-muted">
        <a href="/admin/accounting" className="hover:text-cream">← Accounting</a>
      </div>
      <PageHeader
        eyebrow="Admin · Accounting"
        title="Periods"
        subtitle={`Monthly close + reopen window (${REOPEN_WINDOW_DAYS} days per UK accounting convention). Once a period is locked, it cannot be reopened.`}
      />

      {periods.length === 0 ? (
        <EmptyState
          title="No periods yet"
          hint="Periods are created on first journal post against a (year, month). Once your first invoice is posted, the period row appears here."
        />
      ) : (
        <Card>
          <Table caption="Periods">
            <thead>
              <tr>
                <Th>Period</Th>
                <Th>Closed</Th>
                <Th>Reopen window</Th>
                <Th>Locked</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => {
                const ym = `${p.year}-${String(p.month).padStart(2, '0')}`;
                const isOpen = !p.closedAt && !p.lockedAt;
                const isLocked = !!p.lockedAt;
                const closedAt = p.closedAt;
                const reopen = reopenStatus(p.closedAt, p.lockedAt, now);
                const deadline = reopenDeadline(p.closedAt);
                return (
                  <tr key={p.id}>
                    <Td className="font-mono text-cream">{ym}</Td>
                    <Td>{closedAt ? formatDate(closedAt.toISOString()) : <span className="text-muted">— open —</span>}</Td>
                    <Td>
                      {reopen === 'open' && deadline ? (
                        <span className="text-cream">
                          open · until {formatDate(deadline.toISOString())}
                        </span>
                      ) : closedAt ? (
                        <span className="text-muted">closed</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                    <Td>{isLocked ? <span className="text-[var(--color-loss)]">locked</span> : <span className="text-muted">—</span>}</Td>
                    <Td className="text-right">
                      {isOpen && (
                        <form action={closePeriodAction} className="inline">
                          <input type="hidden" name="year" value={p.year} />
                          <input type="hidden" name="month" value={p.month} />
                          <Button type="submit" variant="outline" size="sm">Close</Button>
                        </form>
                      )}
                      {reopen === 'open' && (
                        <form action={reopenPeriodAction} className="ml-2 inline">
                          <input type="hidden" name="year" value={p.year} />
                          <input type="hidden" name="month" value={p.month} />
                          <Button type="submit" variant="ghost" size="sm">Reopen</Button>
                        </form>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      <Card className="mt-4">
        <CardTitle>How this works</CardTitle>
        <ul className="mt-3 space-y-2 text-sm text-muted">
          <li><span className="text-cream">Close</span> — sets <code>closed_at = now()</code>. The journal-bridge (<code>src/lib/accounting/journal-bridge.ts</code>) then refuses any new post whose period is this (year, month).</li>
          <li><span className="text-cream">Reopen</span> — clears <code>closed_at</code>. Only available for {REOPEN_WINDOW_DAYS} days after close; after that the window is locked.</li>
          <li><span className="text-cream">Lock</span> — sets <code>locked_at = now()</code>. <span className="text-cream">Permanent</span>; cannot be undone. Not exposed in v1; the operator can run an SQL <code>UPDATE</code> on the live DB to set it after monthly close is final.</li>
        </ul>
      </Card>
    </main>
  );
}