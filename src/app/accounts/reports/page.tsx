import { PageHeader, Card, CardTitle, Money, Stat, EmptyState } from '@/components/ui';
import { requireTenantContext, contextCan } from '@/lib/auth/context';
import { assembleBoardReport } from '@/lib/reports';
import { assembleRtbReportFor } from '@/lib/reports/rtb-data';
import { RtbReportSection } from '@/components/rtb/RtbReportSection';
import { RtbReportActions } from '@/components/rtb/RtbReportActions';

export const dynamic = 'force-dynamic';

export default async function AccountsReportsPage() {
  const ctx = await requireTenantContext();
  const canOperational = contextCan(ctx, 'reports.operational');
  const canBoard = contextCan(ctx, 'reports.board');
  const canInvestor = contextCan(ctx, 'reports.investor');

  if (!canOperational && !canBoard && !canInvestor) {
    return (
      <>
        <PageHeader eyebrow="Accounts" title="Reports" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have permission to read any reports. Ask the ops admin to grant
            you <code>reports.operational</code>.
          </p>
        </Card>
      </>
    );
  }

  // The board pack already carries the rent-to-buy book, priced — so the
  // directors' report sums the rent-to-buy operations rather than sitting
  // beside them.
  const board =
    canBoard || canOperational ? await assembleBoardReport(ctx.tenantId).catch(() => null) : null;

  // The investor's book: the same figures, the rentees' names removed.
  const investorRtb = canInvestor
    ? await assembleRtbReportFor(ctx.tenantId, 'investor').catch(() => null)
    : null;

  return (
    <>
      <PageHeader
        eyebrow="Accounts · Reports"
        title="Reports"
        subtitle="Operational + board rollups, depending on what you've been granted."
      />

      {canBoard && board && (
        <section>
          <Card>
            <CardTitle>Board pack</CardTitle>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Fleet utilisation" value={`${board.fleet.utilisation_pct}%`} className="reveal" />
              <Stat label="Active drivers" value={board.operations.active_drivers} className="reveal" />
              <Stat label="Active agreements" value={board.operations.active_agreements} className="reveal" />
              <Stat label="Net (period)" value={<Money pence={board.finance.net_pence} />} tone={board.finance.net_pence >= 0 ? 'profit' : 'loss'} className="reveal" />
            </div>
          </Card>
        </section>
      )}

      {canOperational && (
        <section className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle>Finance summary</CardTitle>
            {board ? (
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex items-center justify-between"><span>Received</span><span className="font-mono"><Money pence={board.finance.received_pence} /></span></li>
                <li className="flex items-center justify-between"><span>Expenses</span><span className="font-mono"><Money pence={board.finance.expenses_pence} /></span></li>
                <li className="flex items-center justify-between border-t border-hair-soft pt-2"><span className="font-display">Net</span><span className="font-display"><Money pence={board.finance.net_pence} /></span></li>
              </ul>
            ) : (
              <EmptyState title="Operational summary unavailable" hint="Grant reports.board to populate this card." />
            )}
          </Card>
          <Card>
            <CardTitle>Risk</CardTitle>
            {board ? (
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex items-center justify-between"><span>Open obligations</span><span className="font-mono">{board.risk.open_obligations}</span></li>
                <li className="flex items-center justify-between"><span>Blocked vehicles</span><span className="font-mono">{board.risk.blocked_vehicles}</span></li>
                <li className="flex items-center justify-between"><span>Blocked drivers</span><span className="font-mono">{board.risk.blocked_drivers}</span></li>
                <li className="flex items-center justify-between"><span>Charges to recover</span><span className="font-mono"><Money pence={board.risk.charges_to_recover_pence} /></span></li>
              </ul>
            ) : (
              <EmptyState title="Risk summary unavailable" hint="Grant reports.board to populate this card." />
            )}
          </Card>
        </section>
      )}

      {canBoard && board?.rtb && (
        <section className="mt-4">
          <RtbReportSection
            report={board.rtb}
            title="Rent-to-buy book — directors' report"
            subtitle="Every rent-to-buy agreement, what the rentee pays, what Brownhill earns, and the rate the book returns."
            actions={<RtbReportActions audience="board" label="directors' report" />}
          />
        </section>
      )}

      {canInvestor && investorRtb && (
        <section className="mt-4">
          <RtbReportSection
            report={investorRtb}
            showNames={false}
            title="Rent-to-buy book — investors' report"
            subtitle="The same figures the board sees, with the rentees' names removed."
            actions={<RtbReportActions audience="investor" label="investors' report" />}
          />
        </section>
      )}
    </>
  );
}
