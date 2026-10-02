import { requirePlatformAdmin } from "@/lib/auth/context";
import Link from "next/link";
import {
  PageHeader,
  Card,
  CardTitle,
  Stat,
  Money,
  Badge,
  Button,
  Table,
  Th,
  Td,
  EmptyState,
} from "@/components/ui";
import { getPlatformOverview, getMrrTrend } from "@/lib/platform/analytics";
import { getPlatformChecklist } from "@/lib/onboarding-checklist";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { formatGBP } from "@/lib/money";

export const dynamic = "force-dynamic";

function bandTone(band: string): "profit" | "warn" | "loss" | "neutral" {
  if (band === "healthy") return "profit";
  if (band === "watch") return "warn";
  if (band === "at_risk") return "loss";
  return "neutral";
}

/** Compact inline area+line sparkline of MRR over the trend window. */
function Sparkline({
  points,
}: {
  points: { day: string; mrrPence: number }[];
}) {
  const W = 640;
  const H = 56;
  const pad = 4;
  const values = points.map((p) => p.mrrPence);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => pad + (H - pad * 2) * (1 - (v - min) / span);

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.mrrPence).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${H - pad} L${x(0).toFixed(1)} ${H - pad} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-14 w-full"
      role="img"
      aria-label="MRR trend"
    >
      <path d={area} fill="rgba(230,197,88,0.10)" stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="#e6c558"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default async function PlatformOverviewPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const [ov, trend, checklist] = await Promise.all([
    getPlatformOverview(),
    getMrrTrend(30),
    getPlatformChecklist(),
  ]);

  const first = trend[0];
  const last = trend[trend.length - 1];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operator console"
        title="Overview"
        subtitle="Your SaaS at a glance"
        actions={
          <Button href="/platform/subscribers" variant="primary" size="sm">
            Onboard subscriber
          </Button>
        }
      />

      <OnboardingChecklist title="Get your platform ready" items={checklist} />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="MRR" value={<Money pence={ov.mrrPence} />} tone="gold" />
        <Stat label="ARR" value={<Money pence={ov.arrPence} />} />
        <Stat label="Paying" value={ov.counts.paying} />
        <Stat label="Active" value={ov.counts.active} />
        <Stat
          label="Trialing"
          value={ov.counts.trialing}
          tone={ov.counts.trialing > 0 ? "warn" : "default"}
        />
        <Stat
          label="Past due"
          value={ov.counts.pastDue}
          tone={ov.counts.pastDue > 0 ? "loss" : "default"}
          hint={`${formatGBP(ov.atRiskMrrPence)} at risk`}
        />
      </div>

      {/* MRR trend */}
      {trend.length >= 2 ? (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>MRR trend</CardTitle>
            <p className="text-xs text-muted tnum">
              <Money pence={last.mrrPence} />{" "}
              <span className="text-muted">· last {trend.length} days</span>
            </p>
          </div>
          <div className="mt-4">
            <Sparkline points={trend} />
          </div>
          <div className="mt-2 flex items-center justify-between text-[0.6875rem] text-muted tnum">
            <span>{first.day}</span>
            <span>{last.day}</span>
          </div>
        </Card>
      ) : (
        <EmptyState
          title="Trend is building"
          hint="Daily snapshots accumulate from the lifecycle cron."
        />
      )}

      {/* At-risk + renewals */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>At-risk subscribers</CardTitle>
          <div className="mt-4 space-y-3">
            {ov.atRisk.length === 0 ? (
              <EmptyState
                title="No subscribers at risk"
                hint="Health scores are all in good standing."
              />
            ) : (
              ov.atRisk.map((r) => (
                <div
                  key={r.tenantId}
                  className="flex items-start justify-between gap-3 border-t border-hair-soft pt-3 first:border-0 first:pt-0"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/platform/subscribers/${r.tenantId}`}
                      className="text-sm text-cream hover:text-gold-bright"
                    >
                      {r.name}
                    </Link>
                    {r.reasons.length > 0 && (
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {r.reasons.slice(0, 2).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted tnum">{r.score}</span>
                    <Badge tone={bandTone(r.band)}>{r.band.replace("_", " ")}</Badge>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <CardTitle>Upcoming renewals (30d)</CardTitle>
          <div className="mt-4 space-y-3">
            {ov.renewalsNext30.length === 0 ? (
              <EmptyState
                title="No renewals in the next 30 days"
                hint="Renewal dates appear here as periods approach."
              />
            ) : (
              ov.renewalsNext30.map((r) => (
                <div
                  key={r.tenantId}
                  className="flex items-center justify-between gap-3 border-t border-hair-soft pt-3 first:border-0 first:pt-0"
                >
                  <Link
                    href={`/platform/subscribers/${r.tenantId}`}
                    className="truncate text-sm text-cream hover:text-gold-bright"
                  >
                    {r.name}
                  </Link>
                  <span className="shrink-0 text-xs text-muted tnum">
                    in {r.daysToEnd}d
                  </span>
                </div>
              ))
            )}
          </div>

          <p className="eyebrow mt-6 text-parchment">Trials ending soon</p>
          <div className="mt-3 space-y-3">
            {ov.trialsEndingSoon.length === 0 ? (
              <p className="text-xs text-muted">No trials ending soon.</p>
            ) : (
              ov.trialsEndingSoon.map((t) => (
                <div
                  key={t.tenantId}
                  className="flex items-center justify-between gap-3 border-t border-hair-soft pt-3 first:border-0 first:pt-0"
                >
                  <Link
                    href={`/platform/subscribers/${t.tenantId}`}
                    className="truncate text-sm text-cream hover:text-gold-bright"
                  >
                    {t.name}
                  </Link>
                  <span className="shrink-0 text-xs text-muted tnum">
                    {t.daysToEnd == null ? "—" : `in ${t.daysToEnd}d`}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Plan mix */}
      <div>
        <p className="eyebrow mb-3 text-parchment">Plan mix</p>
        {ov.planMix.length === 0 ? (
          <EmptyState
            title="No plans in use yet"
            hint="Assign plans to subscribers to see the mix."
          />
        ) : (
          <Table caption="Plans in use">
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th>Subscribers</Th>
                <Th>MRR</Th>
              </tr>
            </thead>
            <tbody>
              {ov.planMix.map((p) => (
                <tr key={p.planId}>
                  <Td>
                    <span className="text-cream">{p.planName}</span>
                  </Td>
                  <Td className="tnum">{p.count}</Td>
                  <Td className="tnum">
                    <Money pence={p.mrrPence} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
