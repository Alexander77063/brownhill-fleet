import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Table, Th, Td, EmptyState } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Every owner on this instance, by tenant, with their vehicles and the last 30 days of alerts. */
export default async function PlatformOwnersPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const sb = createServiceClient();
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [{ data: owners }, { data: vehicles }, { data: alerts }, { data: tenants }] = await Promise.all([
    sb.from("vehicle_owners").select("id, tenant_id, name, phone, user_id").order("name"),
    sb.from("vehicles").select("id, owner_id, registration").not("owner_id", "is", null),
    sb.from("vehicle_alerts").select("owner_id").gte("occurred_at", since),
    sb.from("tenants").select("id, name"),
  ]);
  const tenantName = new Map((tenants ?? []).map((t) => [t.id, t.name]));
  const vehiclesOf = new Map<string, string[]>();
  for (const v of vehicles ?? []) {
    if (!v.owner_id) continue;
    vehiclesOf.set(v.owner_id, [...(vehiclesOf.get(v.owner_id) ?? []), v.registration]);
  }
  const alertsOf = new Map<string, number>();
  for (const a of alerts ?? []) if (a.owner_id) alertsOf.set(a.owner_id, (alertsOf.get(a.owner_id) ?? 0) + 1);

  const byTenant = new Map<string, typeof owners>();
  for (const o of owners ?? []) byTenant.set(o.tenant_id, [...(byTenant.get(o.tenant_id) ?? []), o]);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Owners" title="Vehicle owners on this instance" subtitle="Who is protected, by tenant, with alerts over the last 30 days." />
      {(owners ?? []).length === 0 ? (
        <EmptyState title="No owners yet" hint="Owners appear when an insurer records a policyholder or an individual signs up." />
      ) : (
        [...byTenant.entries()].map(([tid, list]) => (
          <Card key={tid} className="p-0">
            <div className="px-4 pt-4">
              <CardTitle>{tenantName.get(tid) ?? tid}</CardTitle>
            </div>
            <Table caption={`Owners under ${tenantName.get(tid) ?? "tenant"}`}>
              <thead>
                <tr>
                  <Th>Owner</Th>
                  <Th>Phone</Th>
                  <Th>Vehicles</Th>
                  <Th className="text-right">Alerts (30d)</Th>
                  <Th>Account</Th>
                </tr>
              </thead>
              <tbody>
                {(list ?? []).map((o) => (
                  <tr key={o.id}>
                    <Td className="text-cream">{o.name || "—"}</Td>
                    <Td>{o.phone}</Td>
                    <Td className="text-xs">{(vehiclesOf.get(o.id) ?? []).join(", ") || "—"}</Td>
                    <Td className="text-right tnum">{alertsOf.get(o.id) ?? 0}</Td>
                    <Td className="text-xs text-muted">{o.user_id ? "signed in" : "not yet"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ))
      )}
    </div>
  );
}
