import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Badge, Money, EmptyState } from "@/components/ui";
import { aiConfigured } from "@/lib/ai";
import { getPlatformOverview } from "@/lib/platform/analytics";
import CopilotClient from "./copilot-client";

export const dynamic = "force-dynamic";

const BAND_TONE = {
  healthy: "profit",
  watch: "warn",
  at_risk: "loss",
} as const;

export default async function CopilotPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const ov = await getPlatformOverview();
  const configured = aiConfigured();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Copilot"
        title="Operator copilot"
        subtitle="AI insights grounded in your live platform data."
      />

      {!configured && (
        <Card className="border-[var(--color-warn)]">
          <div className="flex items-start gap-3">
            <Badge tone="warn">Dormant</Badge>
            <p className="text-sm text-parchment">
              AI is dormant — add an{" "}
              <span className="text-cream">ANTHROPIC_API_KEY</span> to enable
              chat. The insight cards below are computed from your live data and
              work without a key.
            </p>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Revenue at risk */}
        <Card>
          <div className="flex items-baseline justify-between gap-2">
            <CardTitle>Revenue at risk</CardTitle>
            <Badge tone="loss">Collect</Badge>
          </div>
          {ov.counts.pastDue > 0 ? (
            <p className="mt-3 text-sm text-parchment">
              <span className="text-cream tnum">{ov.counts.pastDue}</span>{" "}
              past-due {ov.counts.pastDue === 1 ? "account" : "accounts"} worth{" "}
              <Money pence={ov.atRiskMrrPence} className="text-[var(--color-loss)]" />{" "}
              in MRR — chase them before they churn.
            </p>
          ) : (
            <div className="mt-3">
              <EmptyState
                title="No past-due accounts"
                hint="Every paying subscriber is current."
              />
            </div>
          )}
        </Card>

        {/* Expansion */}
        <Card>
          <div className="flex items-baseline justify-between gap-2">
            <CardTitle>Expansion</CardTitle>
            <Badge tone="gold">Grow</Badge>
          </div>
          {ov.trialsEndingSoon.length > 0 || ov.addonAttach.length > 0 ? (
            <div className="mt-3 space-y-3 text-sm">
              {ov.trialsEndingSoon.length > 0 ? (
                <div>
                  <p className="text-muted text-xs uppercase tracking-wider">
                    Trials to convert
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {ov.trialsEndingSoon.slice(0, 5).map((t) => (
                      <li
                        key={t.tenantId}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-parchment">{t.name}</span>
                        <span className="text-muted text-xs tnum">
                          {t.daysToEnd == null
                            ? "no end date"
                            : `${t.daysToEnd}d left`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted">No trials ending soon.</p>
              )}
              {ov.addonAttach.length > 0 && (
                <div>
                  <p className="text-muted text-xs uppercase tracking-wider">
                    Add-on attach
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {ov.addonAttach.map((a) => (
                      <Badge key={a.addonKey} tone="neutral">
                        {a.name}: {a.count}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    Low counts are attach gaps — pitch these add-ons to
                    subscribers who lack them.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3">
              <EmptyState
                title="No expansion signals"
                hint="No trials to convert and no add-on data yet."
              />
            </div>
          )}
        </Card>

        {/* Churn watch */}
        <Card>
          <div className="flex items-baseline justify-between gap-2">
            <CardTitle>Churn watch</CardTitle>
            <Badge tone="warn">Retain</Badge>
          </div>
          {ov.atRisk.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {ov.atRisk.slice(0, 5).map((r) => (
                <li
                  key={r.tenantId}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-parchment">{r.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted text-xs">
                      {r.reasons[0] ?? "—"}
                    </span>
                    <Badge
                      tone={
                        BAND_TONE[r.band as keyof typeof BAND_TONE] ?? "neutral"
                      }
                    >
                      {r.band}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-3">
              <EmptyState
                title="No at-risk accounts"
                hint="Health scores are holding steady."
              />
            </div>
          )}
        </Card>

        {/* Renewals */}
        <Card>
          <div className="flex items-baseline justify-between gap-2">
            <CardTitle>Renewals</CardTitle>
            <Badge tone="info">Next 30 days</Badge>
          </div>
          {ov.renewalsNext30.length > 0 ? (
            <div className="mt-3 space-y-3 text-sm">
              <p className="text-parchment">
                <span className="text-cream tnum">
                  {ov.renewalsNext30.length}
                </span>{" "}
                {ov.renewalsNext30.length === 1 ? "renewal" : "renewals"} in the
                next 30 days.
              </p>
              <ul className="space-y-1">
                {ov.renewalsNext30.slice(0, 5).map((r) => (
                  <li
                    key={r.tenantId}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="text-parchment">{r.name}</span>
                    <span className="text-muted text-xs tnum">
                      {r.daysToEnd}d
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-3">
              <EmptyState
                title="No renewals due"
                hint="Nothing renews in the next 30 days."
              />
            </div>
          )}
        </Card>
      </div>

      <CopilotClient configured={configured} />
    </div>
  );
}
