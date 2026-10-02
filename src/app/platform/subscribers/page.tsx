import { requirePlatformAdmin } from "@/lib/auth/context";
import Link from "next/link";
import {
  PageHeader,
  Card,
  CardTitle,
  Button,
  Badge,
  Money,
  Table,
  Th,
  Td,
  EmptyState,
} from "@/components/ui";
import { listSubscribers } from "@/lib/platform/analytics";
import { listCatalogue } from "@/lib/catalogue/manage";
import { deploymentProfile, planAudience } from "@/lib/deployment/profile";
import { onboardSubscriberAction } from "@/lib/actions/platform-console";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

const HEALTH_TONE = {
  healthy: "profit",
  watch: "warn",
  at_risk: "loss",
} as const;

const STATUS_TONE: Record<
  string,
  "profit" | "info" | "loss" | "neutral"
> = {
  active: "profit",
  trialing: "info",
  past_due: "loss",
  cancelled: "neutral",
};

export default async function SubscribersPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  // The onboarding picker offers only this market's plans for this instance's
  // audience — an operator cannot put a Lagos tenant on Starter, or a fleet on
  // the individuals' six-month term.
  const [rows, { plans }] = await Promise.all([
    listSubscribers(),
    listCatalogue(undefined, { region: deploymentProfile().region, audience: planAudience() }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Subscribers"
        title="Subscribers"
        subtitle="Every tenant on the platform."
      />

      <Card>
        <CardTitle>Onboard a subscriber</CardTitle>
        <form
          action={onboardSubscriberAction}
          className="mt-4 flex flex-wrap items-end gap-2"
        >
          <div className="flex flex-col gap-1">
            <label className="eyebrow" htmlFor="onboard-name">
              Company
            </label>
            <input
              id="onboard-name"
              name="name"
              type="text"
              required
              className={inputCls}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="eyebrow" htmlFor="onboard-slug">
              Slug
            </label>
            <input
              id="onboard-slug"
              name="slug"
              type="text"
              required
              placeholder="lowercase-dashes"
              className={inputCls}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="eyebrow" htmlFor="onboard-owner">
              Owner email
            </label>
            <input
              id="onboard-owner"
              name="owner_email"
              type="email"
              required
              className={inputCls}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="eyebrow" htmlFor="onboard-plan">
              Plan
            </label>
            <select
              id="onboard-plan"
              name="plan_id"
              defaultValue=""
              className={inputCls}
            >
              <option value="">Trial (default)</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <Button type="submit" variant="primary" size="sm">
            Onboard
          </Button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="No subscribers yet"
          hint="Onboard your first tenant using the form above."
        />
      ) : (
        <Table caption="Subscribers">
          <thead>
            <tr>
              <Th>Subscriber</Th>
              <Th>Plan</Th>
              <Th>Status</Th>
              <Th>MRR</Th>
              <Th>Health</Th>
              <Th>Vehicles</Th>
              <Th>Last active</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/platform/subscribers/${r.id}`}
                      className="text-cream hover:text-gold-bright"
                    >
                      {r.name}
                    </Link>
                    {r.isOperator && <Badge tone="gold">You</Badge>}
                    {r.planDrift && <Badge tone="warn">plan drift</Badge>}
                  </div>
                  <p className="text-xs text-muted">{r.slug}</p>
                </Td>
                <Td className="text-cream">{r.planName}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                    {r.status}
                  </Badge>
                </Td>
                <Td>
                  <Money pence={r.mrrPence} />
                </Td>
                <Td>
                  <Badge tone={HEALTH_TONE[r.health.band]}>
                    {r.health.band} · {r.health.score}
                  </Badge>
                </Td>
                <Td className="tnum">{r.usage.vehicles}</Td>
                <Td>
                  {r.lastActivity
                    ? new Date(r.lastActivity).toISOString().slice(0, 10)
                    : "—"}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
