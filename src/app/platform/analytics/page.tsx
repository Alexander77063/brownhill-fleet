import { requirePlatformAdmin } from "@/lib/auth/context";
import {
  PageHeader,
  Card,
  CardTitle,
  Stat,
  Money,
  Table,
  Th,
  Td,
  EmptyState,
} from "@/components/ui";
import { getPlatformOverview, getMrrTrend } from "@/lib/platform/analytics";

export const dynamic = "force-dynamic";

const GOLD = "#e6c558";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function AnalyticsPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const [ov, trend] = await Promise.all([
    getPlatformOverview(),
    getMrrTrend(90),
  ]);

  // ── MRR trend chart geometry ──────────────────────────────────────────────
  const hasTrend = trend.length >= 2;
  const peakMrr = hasTrend ? Math.max(...trend.map((t) => t.mrrPence)) : 0;
  // Floor the height divisor at 1 to avoid a zero denominator; the *displayed*
  // peak uses peakMrr so an all-zero window reads £0.00, not £0.01.
  const maxMrr = Math.max(peakMrr, 1);
  const CW = 300; // viewBox width
  const CH = 120; // viewBox height
  const PAD_B = 4; // baseline padding
  const usableH = CH - PAD_B;
  const barGap = 1;
  const barW = hasTrend ? CW / trend.length : 0;
  const first = hasTrend ? trend[0] : null;
  const last = hasTrend ? trend[trend.length - 1] : null;

  // ── Plan mix geometry ─────────────────────────────────────────────────────
  const maxPlanCount = ov.planMix.reduce((m, p) => Math.max(m, p.count), 0);

  // ── Subscriber mix ────────────────────────────────────────────────────────
  const mix: { label: string; count: number; tone: string }[] = [
    { label: "Active", count: ov.counts.active, tone: "var(--color-profit)" },
    { label: "Trialing", count: ov.counts.trialing, tone: "var(--color-info)" },
    { label: "Past due", count: ov.counts.pastDue, tone: "var(--color-loss)" },
    { label: "Cancelled", count: ov.counts.cancelled, tone: "var(--color-warn)" },
  ];
  const maxMix = mix.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Analytics" title="Revenue & growth" />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="MRR" value={<Money pence={ov.mrrPence} />} tone="gold" />
        <Stat label="ARR" value={<Money pence={ov.arrPence} />} />
        <Stat
          label="Paying subscribers"
          value={ov.counts.paying}
          hint={`${ov.counts.active} active · ${ov.counts.trialing} trialing`}
        />
        <Stat
          label="At-risk MRR"
          value={<Money pence={ov.atRiskMrrPence} />}
          tone="loss"
          hint={`${ov.counts.pastDue} past-due account${ov.counts.pastDue === 1 ? "" : "s"}`}
        />
      </div>

      {/* MRR trend */}
      <Card>
        <CardTitle>MRR trend (90d)</CardTitle>
        {hasTrend ? (
          <div className="mt-4">
            <svg
              viewBox={`0 0 ${CW} ${CH}`}
              preserveAspectRatio="none"
              className="w-full h-32"
              role="img"
              aria-label="Monthly recurring revenue over the last 90 days"
            >
              {/* baseline */}
              <line
                x1={0}
                y1={CH - PAD_B}
                x2={CW}
                y2={CH - PAD_B}
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeWidth={0.5}
                className="text-cream"
              />
              {trend.map((t, i) => {
                const h = (t.mrrPence / maxMrr) * usableH;
                const x = i * barW;
                const y = CH - PAD_B - h;
                return (
                  <rect
                    key={t.day}
                    x={x + barGap / 2}
                    y={y}
                    width={Math.max(barW - barGap, 0.5)}
                    height={h}
                    fill={GOLD}
                    fillOpacity={0.85}
                  />
                );
              })}
            </svg>
            <div className="mt-2 flex items-center justify-between text-xs text-muted">
              <span className="tnum">{first ? fmtDate(first.day) : ""}</span>
              <span className="text-parchment">
                peak <Money pence={peakMrr} className="text-gold-bright" />
              </span>
              <span className="tnum">{last ? fmtDate(last.day) : ""}</span>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState
              title="Collecting snapshots"
              hint="The trend fills in as the daily lifecycle cron runs."
            />
          </div>
        )}
      </Card>

      {/* Plan mix */}
      <Card>
        <CardTitle>Plan mix</CardTitle>
        {ov.planMix.length ? (
          <div className="mt-4 space-y-3">
            {ov.planMix.map((p) => {
              const pct =
                maxPlanCount > 0 ? (p.count / maxPlanCount) * 100 : 0;
              return (
                <div key={p.planId}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-cream">{p.planName}</span>
                    <span className="flex items-baseline gap-3 text-xs text-muted">
                      <span className="tnum text-parchment">
                        {p.count} tenant{p.count === 1 ? "" : "s"}
                      </span>
                      <Money pence={p.mrrPence} className="text-parchment" />
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full border border-hair-soft bg-[var(--surface-soft)]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-gold to-gold-bright"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState title="No plans in use yet" />
          </div>
        )}
      </Card>

      {/* Add-on attach */}
      <Card>
        <CardTitle>Add-on attach</CardTitle>
        {ov.addonAttach.length ? (
          <div className="mt-4">
            <Table caption="Add-on attach rates">
              <thead>
                <tr>
                  <Th>Add-on</Th>
                  <Th>Attached</Th>
                </tr>
              </thead>
              <tbody>
                {ov.addonAttach.map((a) => (
                  <tr key={a.addonKey}>
                    <Td>{a.name}</Td>
                    <Td className="tnum">{a.count}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState
              title="No add-ons attached"
              hint="Attach add-ons from the Tenants page."
            />
          </div>
        )}
      </Card>

      {/* Subscriber mix */}
      <Card>
        <CardTitle>Subscriber mix</CardTitle>
        <p className="mt-1 text-xs text-muted">
          {ov.counts.total} tenant{ov.counts.total === 1 ? "" : "s"} across all
          lifecycle states.
        </p>
        <div className="mt-4 space-y-3">
          {mix.map((r) => {
            const pct = maxMix > 0 ? (r.count / maxMix) * 100 : 0;
            return (
              <div key={r.label}>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="text-parchment">{r.label}</span>
                  <span className="tnum text-cream">{r.count}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full border border-hair-soft bg-[var(--surface-soft)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, backgroundColor: r.tone }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
