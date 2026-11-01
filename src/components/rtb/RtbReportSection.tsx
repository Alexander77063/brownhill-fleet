import { Badge, Card, CardTitle, EmptyState, Stat, Table, Th, Td } from '@/components/ui';
import { formatGBP } from '@/lib/money';
import {
  RTB_DEAL_COLUMNS,
  costBasisLabel,
  rtbReportSummary,
} from '@/lib/reports/rtb-format';
import type { RtbReport } from '@/lib/reports/rtb';

/**
 * The rent-to-buy book, on screen.
 *
 * The same figures the downloadable document and the email carry — they all
 * read `rtbReportSummary` and `rtbDealLines`, so a director reading the screen
 * and an investor reading the email are reading the same numbers.
 */
export function RtbReportSection({
  report,
  showNames = true,
  title = 'Rent-to-buy book',
  subtitle,
  actions,
}: {
  report: RtbReport;
  /** Show the rentee's name. Off for investors — it is not their business. */
  showNames?: boolean;
  title?: string;
  subtitle?: string;
  /** Download and email controls, rendered in the header. */
  actions?: React.ReactNode;
}) {
  if (report.rows.length === 0) {
    return (
      <Card>
        <CardTitle>{title}</CardTitle>
        <div className="mt-3">
          <EmptyState
            title="No rent-to-buy agreements yet"
            hint="Price one on the RTB calculator and it appears here, with the rate the rentee pays and the rate Brownhill earns."
          />
        </div>
      </Card>
    );
  }

  const summary = rtbReportSummary(report);
  const totals = report.totals;

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 pt-4">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 text-xs text-muted">
            {subtitle ??
              'What each rentee pays, what Brownhill earns, and the rate the whole book returns.'}
          </p>
        </div>
        {actions}
      </div>

      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
        {summary.map((line) => (
          <Stat
            key={line.label}
            label={line.label}
            value={line.value}
            hint={line.hint}
            tone={line.tone === 'profit' ? 'profit' : line.tone === 'loss' ? 'loss' : 'default'}
          />
        ))}
      </div>

      <Table caption={`Rent-to-buy agreements — ${report.tenantName}`}>
        <thead>
          <tr>
            {RTB_DEAL_COLUMNS.filter((c) => showNames || c !== 'Rentee').map((c) => (
              <Th key={c}>{c}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.agreementId}>
              <Td className="text-cream">{row.registration ?? '—'}</Td>
              {showNames && <Td>{row.driverName ?? '—'}</Td>}
              <Td>
                <Badge tone={row.status === 'active' ? 'profit' : 'neutral'}>{row.status}</Badge>
              </Td>
              <Td className="tnum">{row.termMonths || 0}</Td>
              <Td className="text-right tnum">{money(row.monthlyGrossPence)}</Td>
              <Td className="text-right tnum">{money(row.depositPence)}</Td>
              <Td className="text-right tnum">{money(row.totalRentNetPence)}</Td>
              <Td className="text-right tnum">{money(row.agreedResidualPence)}</Td>
              <Td className="text-right tnum">{money(row.effectiveCostPence)}</Td>
              <Td className="text-xs text-muted">{costBasisLabel(row.costBasis)}</Td>
              <Td className="text-right tnum">{pct(row.renteeAprPct)}</Td>
              <Td className="text-right tnum text-gold-bright">{pct(row.companyYieldPct)}</Td>
              <Td
                className={`text-right tnum ${
                  row.companyMarginPence < 0 ? 'text-[var(--color-loss)]' : 'text-[var(--color-profit)]'
                }`}
              >
                {money(row.companyMarginPence)}
              </Td>
              <Td className="text-right tnum">{money(row.buyoutBalancePence)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="space-y-2 px-4 py-4 text-xs text-muted">
        <p>
          The book costs {money(totals.totalCostPence)} and returns {money(totals.totalCashInPence)} —
          a margin of {money(totals.totalMarginPence)} over the terms, or{' '}
          {totals.moneyMultiple === null ? '—' : `${totals.moneyMultiple.toFixed(2)}×`} for every pound spent.
        </p>
        <p>
          The rentee&apos;s contract is monthly; the system bills weekly. The weekly rate is the monthly
          payment divided across the term&apos;s weeks and rounded to the penny, so across this book the two
          differ by {money(totals.weeklyRoundingPence)}.
        </p>
        {totals.portfolioYieldNote && <p>{totals.portfolioYieldNote}</p>}
        {report.rows
          .filter((row) => row.notes.length > 0)
          .map((row) => (
            <p key={row.agreementId}>
              <span className="text-parchment">{row.registration ?? row.agreementId}</span> — {row.notes.join(' ')}
            </p>
          ))}
      </div>
    </Card>
  );
}

/* Small local formatters so the section does not depend on the renderer's
 * pre-formatted strings for figures it shows in its own table. `formatGBP` with
 * pence shown is exactly what the `<Money>` component renders, so a figure on
 * screen and the same figure in the downloaded document are the same string. */
function money(pence: number): string {
  return formatGBP(pence, { showPence: true });
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}%`;
}
