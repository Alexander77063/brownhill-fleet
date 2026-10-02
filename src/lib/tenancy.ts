/**
 * Tenant provisioning & administration (F6). Server-side, service-role functions
 * that create tenants, manage their settings, and manage members. The callable
 * boundaries (server actions) enforce permissions with requirePermission; these
 * functions take an explicit tenantId and trust that guard, mirroring signing.ts.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { regionProvider } from "@/lib/region";
import { seedDefaultCategories } from "@/lib/expenses";
import { sendSigninInvite } from "@/lib/invite-email";

type Sb = ReturnType<typeof createServiceClient>;

async function audit(
  sb: Sb,
  tenantId: string,
  action: string,
  entityId: string | null,
  detail: Record<string, unknown>,
  actor?: string | null,
): Promise<void> {
  await sb.rpc("log_audit", {
    p_tenant: tenantId,
    p_action: action,
    p_entity_type: "tenant",
    p_entity_id: entityId ?? undefined,
    p_detail: detail as never,
    p_actor: actor ?? undefined,
  });
}

const DEFAULT_PREFIXES = {
  INV: "INV",
  EXP: "EXP",
  BKG: "BKG",
  RCP: "RCP",
  PCN: "PCN",
  AGR: "AGR",
};
const DEFAULT_MODULES = {
  rental: true,
  compliance: true,
  bookings: false,
  gps: false,
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Provision a new tenant and make the creator its owner (self-onboarding). */
export async function createTenant(
  input: { name: string; slug: string },
  ownerUserId: string,
): Promise<{ id: string }> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!name) throw new Error("Please enter a business name.");
  if (!SLUG_RE.test(slug))
    throw new Error(
      "Slug must be 3–40 chars: lowercase letters, numbers and hyphens.",
    );

  const sb = createServiceClient();
  const { data: existing } = await sb
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) throw new Error(`The slug "${slug}" is already taken.`);

  const { data: tenant, error } = await sb
    .from("tenants")
    .insert({
      name,
      slug,
      plan: "trial",
      status: "active",
      branding: {} as never,
      modules: DEFAULT_MODULES as never,
      ref_prefixes: DEFAULT_PREFIXES as never,
    })
    .select("id")
    .single();
  if (error || !tenant)
    throw new Error(`Could not create tenant: ${error?.message ?? "unknown"}`);

  const { error: mErr } = await sb
    .from("tenant_memberships")
    .insert({
      tenant_id: tenant.id,
      user_id: ownerUserId,
      role: "owner",
      status: "active",
    });
  if (mErr)
    throw new Error(`Could not create owner membership: ${mErr.message}`);

  // Seed default expense/charge categories so the finance surfaces are usable
  // from day one. Best-effort — never block tenant creation on it.
  await seedDefaultCategories(tenant.id, sb).catch(() => {});

  // Entitlement (SP-A): put every new tenant on this market's default plan so
  // entitlement-gating works from day one (grandfather only covered pre-existing
  // tenants). Best-effort — if the catalogue isn't seeded yet, tenant creation
  // still succeeds.
  const { data: defaultPlan } = await sb
    .from("plans")
    .select("id")
    .eq("key", regionProvider().billing.defaultPlanKey)
    .maybeSingle();
  if (defaultPlan?.id) {
    await sb
      .from("tenant_subscription")
      .upsert(
        {
          tenant_id: tenant.id,
          plan_id: defaultPlan.id,
          // The UK trials; Nigeria is pay-first and starts `unpaid` (NG-2).
          status: regionProvider().billing.initialStatus,
        } as never,
        { onConflict: "tenant_id" },
      );
  }

  await audit(
    sb,
    tenant.id,
    "tenant.created",
    tenant.id,
    { name, slug },
    ownerUserId,
  );
  return { id: tenant.id };
}

export interface TenantSettings {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  branding: Record<string, unknown>;
  modules: Record<string, unknown>;
  ref_prefixes: Record<string, unknown>;
}

export async function getTenant(
  tenantId: string,
): Promise<TenantSettings | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();
  return (data as unknown as TenantSettings) ?? null;
}

export interface TenantPatch {
  name?: string;
  plan?: "trial" | "starter" | "growth" | "scale";
  status?: "active" | "suspended" | "cancelled";
  branding?: Record<string, unknown>;
  modules?: Record<string, unknown>;
  ref_prefixes?: Record<string, unknown>;
}

export async function updateTenantSettings(
  tenantId: string,
  patch: TenantPatch,
  actor: string,
): Promise<void> {
  const sb = createServiceClient();
  const row: Record<string, unknown> = {};
  if (patch.name != null) row.name = patch.name.trim();
  if (patch.plan) row.plan = patch.plan;
  if (patch.status) row.status = patch.status;
  if (patch.branding) row.branding = patch.branding;
  if (patch.modules) row.modules = patch.modules;
  if (patch.ref_prefixes) row.ref_prefixes = patch.ref_prefixes;
  if (Object.keys(row).length === 0) return;

  const { error } = await sb
    .from("tenants")
    .update(row as never)
    .eq("id", tenantId);
  if (error) throw new Error(`Could not update settings: ${error.message}`);
  await audit(
    sb,
    tenantId,
    "tenant.settings_updated",
    tenantId,
    { fields: Object.keys(row) },
    actor,
  );
}

export interface Member {
  user_id: string;
  role: string;
  permissions: string[];
  status: string;
  full_name: string | null;
  email: string | null;
}

export async function listMembers(tenantId: string): Promise<Member[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("tenant_memberships")
    .select("user_id, role, permissions, status")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as {
    user_id: string;
    role: string;
    permissions: string[];
    status: string;
  }[];
  if (rows.length === 0) return [];

  const { data: profiles } = await sb
    .from("profiles")
    .select("id, full_name, email")
    .in(
      "id",
      rows.map((r) => r.user_id),
    );
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
  return rows.map((r) => ({
    ...r,
    full_name: byId.get(r.user_id)?.full_name ?? null,
    email: byId.get(r.user_id)?.email ?? null,
  }));
}

/** Add an existing user (by email) to the tenant with a role. Invite-by-email for
 * users who haven't signed up yet is a later enhancement. */
export async function addMemberByEmail(
  tenantId: string,
  email: string,
  role: string,
  actor: string,
): Promise<{ created: boolean; emailed: boolean }> {
  const sb = createServiceClient();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) throw new Error("An email address is required.");

  // Resolve the person's account — or provision one so a colleague doesn't have
  // to pre-register (mirrors the driver-invite / owner-onboarding flow). Every
  // write is scoped to the caller's tenant, which the action guard has checked.
  const { data: profile } = await sb
    .from("profiles")
    .select("id")
    .eq("email", cleanEmail)
    .maybeSingle();

  let userId: string;
  let created = false;
  if (profile) {
    userId = profile.id;
  } else {
    // A brand-new driver account can't be provisioned here: the driver portal
    // resolves the user via profiles.driver_id, which ONLY the driver invite
    // sets (it also creates the drivers row). Provisioning one here would leave
    // them stranded in a portal that can't find them — send them to that flow.
    if (role === "driver")
      throw new Error(
        `To invite a driver, use Ops → Drivers → Invite — it creates their driver record and login together. The team-member form is for office roles.`,
      );
    const { data: authData, error: createErr } = await sb.auth.admin.createUser({
      email: cleanEmail,
      email_confirm: true,
      user_metadata: { role: "ops", full_name: cleanEmail.split("@")[0] },
    });
    if (createErr || !authData?.user)
      throw new Error(
        `Could not create an account for ${cleanEmail}: ${createErr?.message ?? "unknown error"}`,
      );
    userId = authData.user.id;
    created = true;
  }

  const { error } = await sb
    .from("tenant_memberships")
    .upsert(
      { tenant_id: tenantId, user_id: userId, role, status: "active" },
      { onConflict: "tenant_id,user_id" },
    );
  if (error) throw new Error(`Could not add member: ${error.message}`);

  // Email a one-click sign-in invite to a freshly-created member (best-effort).
  let emailed = false;
  if (created) {
    const { data: tenant } = await sb
      .from("tenants")
      .select("name")
      .eq("id", tenantId)
      .maybeSingle();
    const tenantName = tenant?.name ?? "your organisation";
    emailed = await sendSigninInvite(sb, cleanEmail, {
      subject: `You've been added to ${tenantName} on Elite Fleet Management`,
      heading: `You're on the team at ${tenantName}`,
      body: `You've been given access to ${tenantName}'s fleet workspace on Elite Fleet Management. Click below to sign in — no separate sign-up needed.`,
    });
  }

  await audit(
    sb,
    tenantId,
    "member.added",
    tenantId,
    { email: cleanEmail, role, created },
    actor,
  );
  return { created, emailed };
}

export async function updateMember(
  tenantId: string,
  userId: string,
  patch: {
    role?: string;
    permissions?: string[];
    status?: "active" | "invited" | "disabled";
  },
  actor: string,
): Promise<void> {
  const sb = createServiceClient();
  const row: Record<string, unknown> = {};
  if (patch.role) row.role = patch.role;
  if (patch.permissions) row.permissions = patch.permissions;
  if (patch.status) row.status = patch.status;
  if (Object.keys(row).length === 0) return;

  const { error } = await sb
    .from("tenant_memberships")
    .update(row as never)
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  if (error) throw new Error(`Could not update member: ${error.message}`);
  await audit(
    sb,
    tenantId,
    "member.updated",
    tenantId,
    { user_id: userId, fields: Object.keys(row) },
    actor,
  );
}
