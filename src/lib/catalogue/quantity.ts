/**
 * How many vehicles a subscription bills for.
 *
 * Metered, never declared: a per-vehicle price only works if the count is what
 * the tenant actually has, and a fleet that could type its own number would
 * type a smaller one. `sold` is the one status that means the vehicle is gone;
 * `off_road` is still protected and still billed.
 *
 * Two writers: the vehicle server actions call `syncBilledVehicles` after a
 * write so the number on /ops/billing is right when the operator looks, and the
 * nightly subscription-lifecycle cron calls `syncAllBilledVehicles` so an
 * import or a missed action cannot leave it stale for more than a day.
 */
import { createServiceClient } from "@/lib/supabase/server";

type Sb = ReturnType<typeof createServiceClient>;

export async function syncBilledVehicles(
  tenantId: string,
  sb: Sb = createServiceClient(),
): Promise<number> {
  const { count, error } = await sb
    .from("vehicles")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .neq("status", "sold");
  if (error) throw new Error(error.message);
  const billed = count ?? 0;
  const { error: uErr } = await sb
    .from("tenant_subscription")
    .update({ billed_vehicles: billed } as never)
    .eq("tenant_id", tenantId);
  if (uErr) throw new Error(uErr.message);
  return billed;
}

export async function syncAllBilledVehicles(sb: Sb = createServiceClient()): Promise<void> {
  const { data, error } = await sb.from("tenant_subscription").select("tenant_id");
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    await syncBilledVehicles(row.tenant_id, sb);
  }
}
