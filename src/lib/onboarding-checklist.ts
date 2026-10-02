/** Getting-started checklists, derived entirely from real data (no stored state,
 *  so they self-update and never drift). Used by the tenant `/ops` home and the
 *  platform `/platform` home to drive activation. */
import { getAuthContext } from "@/lib/auth/context";
import { getBranding } from "@/lib/branding";
import { getVehicles, getDrivers, getAgreements } from "@/lib/queries";
import { getTenantAiStatus } from "@/lib/ops/assistant";
import { listMembers } from "@/lib/tenancy";
import { getPlatformOverview } from "@/lib/platform/analytics";
import { aiConfigured } from "@/lib/ai";

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  href: string;
  /** Optional steps don't count toward "Setup complete" (e.g. a solo operator
   *  never invites a team). Shown, but never block completion. */
  optional?: boolean;
}

/** Tenant operator's setup checklist (runs in the /ops authed context). */
export async function getTenantChecklist(): Promise<ChecklistItem[]> {
  const ctx = await getAuthContext();
  const [branding, vehicles, drivers, agreements, ai, members] = await Promise.all([
    getBranding(),
    getVehicles(),
    getDrivers(),
    getAgreements(),
    getTenantAiStatus().catch(() => null),
    ctx?.tenantId ? listMembers(ctx.tenantId) : Promise.resolve([]),
  ]);

  return [
    {
      key: "branding",
      label: "Add your logo & company details",
      done: !!(branding.logo_url || branding.legal_name || branding.trading_name),
      href: "/admin/branding",
    },
    { key: "team", label: "Invite your team", done: members.length > 1, href: "/admin", optional: true },
    { key: "vehicles", label: "Add your vehicles", done: vehicles.length > 0, href: "/ops/import" },
    { key: "drivers", label: "Add & invite drivers", done: drivers.length > 0, href: "/ops/drivers" },
    // AI works out of the box on the platform key (hybrid), so readiness — not a
    // stored BYO key — marks this done.
    { key: "ai", label: "Set up your AI assistant", done: !!ai?.ready, href: "/admin/assistant" },
    {
      key: "agreement",
      label: "Create your first agreement",
      done: agreements.length > 0,
      href: "/ops/agreements",
    },
  ];
}

/** Platform operator's setup checklist (runs in the /platform authed context). */
export async function getPlatformChecklist(): Promise<ChecklistItem[]> {
  const overview = await getPlatformOverview();
  return [
    {
      key: "subscriber",
      label: "Onboard your first subscriber",
      done: overview.counts.total > 0,
      href: "/platform/subscribers",
    },
    {
      key: "copilot",
      label: "Enable the AI copilot",
      done: aiConfigured(),
      href: "/platform/copilot",
    },
    {
      key: "plans",
      label: "Review your plans & pricing",
      done: overview.planMix.length > 0,
      href: "/platform/catalogue",
    },
  ];
}
