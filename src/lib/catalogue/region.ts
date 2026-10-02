import type { RegionId } from "@/lib/deployment/profile";

/**
 * Which market a plan belongs to.
 *
 * `plans.region` is nullable: every row that predates regions is a UK plan, and
 * resolving null here — once — means no caller special-cases "old rows". An
 * unknown value throws because the alternative is formatting a price in the
 * wrong currency, which looks like a real number.
 */
export function regionOf(plan: { region: string | null }): RegionId {
  const stored = plan.region ?? "uk";
  if (stored !== "uk" && stored !== "ng") {
    throw new Error(`Plan has unknown region "${stored}".`);
  }
  return stored;
}
