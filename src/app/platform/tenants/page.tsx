import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Button } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { listTenantsWithPlans, listCatalogue } from "@/lib/catalogue/manage";
import { deploymentProfile } from "@/lib/deployment/profile";
import {
  setTenantPlanAction,
  toggleTenantAddonAction,
} from "@/lib/actions/platform";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export default async function TenantsPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const sb = createServiceClient();
  const [tenants, { plans, addons }, active] = await Promise.all([
    listTenantsWithPlans(sb),
    // Only this market's plans: a Lagos tenant must never be put on Starter.
    listCatalogue(sb, { region: deploymentProfile().region }),
    sb
      .from("tenant_addons")
      .select("tenant_id, addon_id")
      .eq("status", "active"),
  ]);
  const activeSet = new Set(
    (active.data ?? []).map((r) => `${r.tenant_id}:${r.addon_id}`),
  );
  const planName = (id: string | null | undefined) =>
    plans.find((p) => p.id === id)?.name ?? "none";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Tenants"
        title="Tenant subscriptions"
        subtitle="Assign plans and toggle add-ons per subscriber."
      />

      {tenants.map((t) => (
        <Card key={t.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{t.name}</CardTitle>
            <p className="text-xs text-muted">
              {t.slug} · plan:{" "}
              <span className="text-cream">
                {planName(t.subscription?.plan_id)}
              </span>
            </p>
          </div>

          <form
            action={setTenantPlanAction}
            className="mt-3 flex items-center gap-2"
          >
            <input type="hidden" name="tenant_id" value={t.id} />
            <select
              name="plan_id"
              aria-label={`Plan for ${t.name}`}
              defaultValue={t.subscription?.plan_id ?? ""}
              className={inputCls}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="outline" size="sm">
              Set plan
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap gap-2">
            {addons.map((a) => (
              <form
                key={a.id}
                action={toggleTenantAddonAction}
                className="flex items-center gap-2 rounded-md border border-hair px-2.5 py-1.5 text-xs"
              >
                <input type="hidden" name="tenant_id" value={t.id} />
                <input type="hidden" name="addon_id" value={a.id} />
                <label className="flex items-center gap-1.5 text-parchment">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={activeSet.has(`${t.id}:${a.id}`)}
                  />
                  {a.key}
                </label>
                <Button type="submit" variant="outline" size="sm">
                  Save
                </Button>
              </form>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
