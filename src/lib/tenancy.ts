/**
 * Tenant provisioning & administration (F6). Server-side, service-role functions
 * that create tenants, manage their settings, and manage members. The callable
 * boundaries (server actions) enforce permissions with requirePermission; these
 * functions take an explicit tenantId and trust that guard, mirroring signing.ts.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { regionProvider } from "@/lib/region";
import { seedDefaultCategories } from "@/lib/expenses";
import { esc, sendSigninInvite } from "@/lib/invite-email";
import { deploymentProfile } from "@/lib/deployment/profile";
import { portalRoleFor } from "@/lib/iam";
import { createLocalUser, localHasPassword, setLocalPassword } from "@/lib/auth/local-store";
import { generateTemporaryPassword } from "@/lib/auth/password-reset";
import { sendTenantEmail } from "@/lib/email/tenant-email";
import { localDb } from "@/lib/db/local";

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

/** One member of the current tenant, or null if not a member. */
export async function getMember(tenantId: string, userId: string): Promise<Member | null> {
  const sb = createServiceClient();
  const { data: row } = await sb
    .from("tenant_memberships")
    .select("user_id, role, permissions, status")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return null;
  const r = row as { user_id: string; role: string; permissions: string[]; status: string };
  const { data: profile } = await sb
    .from("profiles")
    .select("full_name, email")
    .eq("id", userId)
    .maybeSingle();
  const p = profile as { full_name: string | null; email: string | null } | null;
  return {
    user_id: r.user_id,
    role: r.role,
    permissions: r.permissions ?? [],
    status: r.status,
    full_name: p?.full_name ?? null,
    email: p?.email ?? null,
  };
}

/**
 * The account that already exists for this email address, if any.
 *
 * On the SaaS the account lives in Supabase Auth, and `profiles` is the mirror
 * of it that the app can read. On a self-hosted build the account lives in
 * `auth.users`, which PostgREST does not expose — it serves only the `public`
 * schema — so it is read over the direct connection instead.
 */
async function findAccountByEmail(email: string): Promise<string | null> {
  if (deploymentProfile().supabaseAuth) {
    const sb = createServiceClient();
    const { data: profile } = await sb
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    return (profile as { id: string } | null)?.id ?? null;
  }
  const db = await localDb();
  const rows = (await db`
    select id from auth.users where email = ${email} limit 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export interface AddMemberResult {
  /** True when this call created the colleague's account. */
  created: boolean;
  /** True when a sign-in email actually went out. */
  emailed: boolean;
  /** The colleague's account id. */
  userId: string;
  /**
   * The password the operator must hand over.
   *
   * Set when this deployment created the account itself. The box signs its own
   * sessions and usually has no email provider, so a password that is only ever
   * emailed would reach nobody. It is shown once, in the panel, and never
   * stored in the clear.
   */
  temporaryPassword?: string;
  /** True when the colleague already had an account and was only given a membership. */
  existingAccount: boolean;
}

/**
 * Add a colleague to the tenant, creating their login if they do not have one.
 *
 * ## The two deployments provision accounts in different places
 *
 * The SaaS has Supabase Auth behind `sb.auth`, so `auth.admin.createUser`
 * creates the account and a magic-link email lets them in.
 *
 * A self-hosted build has NO auth server at all. That call would be sent to the
 * application's own origin, where nothing answers it and Next serves its own
 * 404 page — so the operator saw, for every single new colleague:
 *
 *     Could not create an account for someone@company.com:
 *     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * and no account was created at all. Here the account is created in the local
 * store (`auth.users` + `auth.local_credentials`) exactly the way the first-run
 * setup and the driver invite create one, and the operator is handed the
 * password, because a box with no email provider is the normal case.
 */
export async function addMemberByEmail(
  tenantId: string,
  email: string,
  role: string,
  actor: string,
  extraPermissions: readonly string[] = [],
): Promise<AddMemberResult> {
  const sb = createServiceClient();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) throw new Error("An email address is required.");

  // The portal this colleague will land in. The tenant role says what they may
  // do; the portal role says which app they open. They are two vocabularies,
  // and the account carries the portal one — 'owner' is the tenant's own
  // full-control role and belongs on the operations desk, not in the
  // vehicle-owner portal this deployment does not have.
  const portalRole = portalRoleFor(role);

  // Resolve the person's account — or provision one so a colleague doesn't have
  // to pre-register (mirrors the driver-invite / owner-onboarding flow). Every
  // write is scoped to the caller's tenant, which the action guard has checked.
  const existingUserId = await findAccountByEmail(cleanEmail);

  let userId: string;
  let created = false;
  let temporaryPassword: string | undefined;

  if (existingUserId) {
    userId = existingUserId;
  } else {
    // A brand-new driver account can't be provisioned here: the driver portal
    // resolves the user via profiles.driver_id, which ONLY the driver invite
    // sets (it also creates the drivers row). Provisioning one here would leave
    // them stranded in a portal that can't find them — send them to that flow.
    if (role === "driver")
      throw new Error(
        `To invite a driver, use Ops → Drivers → Invite — it creates their driver record and login together. The team-member form is for office roles.`,
      );

    if (deploymentProfile().supabaseAuth) {
      const { data: authData, error: createErr } = await sb.auth.admin.createUser({
        email: cleanEmail,
        email_confirm: true,
        // The handle_new_user trigger reads raw_user_meta_data->>'role' to
        // decide which portal the new account lands on. It is given the PORTAL
        // role, not the tenant role: the trigger maps portal roles to
        // themselves, so this is what puts the colleague in the right app.
        user_metadata: { role: portalRole, full_name: cleanEmail.split("@")[0] },
      });
      if (createErr || !authData?.user)
        throw new Error(
          `Could not create an account for ${cleanEmail}: ${createErr?.message ?? "unknown error"}`,
        );
      userId = authData.user.id;
    } else {
      // No auth server here, so the account is created in the local store:
      // the account row, the credential row and the profile the trigger makes
      // from it, in the same shape the first-run setup uses.
      temporaryPassword = generateTemporaryPassword();
      const createdUser = await createLocalUser(cleanEmail, temporaryPassword, {
        role: portalRole,
        fullName: cleanEmail.split("@")[0],
      });
      userId = createdUser.id;
    }
    created = true;
  }

  // A colleague who already had an account may never have had a password — a
  // phone-only sign-in, or an account seeded straight into the database. On
  // this deployment the operator is the only way that person can ever get in,
  // so issue them one. An account that already has a password is left alone:
  // re-adding someone must never silently reset the password they are using.
  if (!created && !temporaryPassword && !deploymentProfile().supabaseAuth) {
    if (!(await localHasPassword(userId))) {
      temporaryPassword = generateTemporaryPassword();
      await setLocalPassword(userId, temporaryPassword);
    }
  }

  // Make sure the account has a profile in the portal it should land in. The
  // sign-up trigger creates one when the account row is inserted; an account
  // that predates this, or whose insert did not fire the trigger, would have
  // none — and a member with no profile is treated as a driver. An EXISTING
  // profile is left alone: the portal a colleague already uses is not this
  // form's to change.
  if (!deploymentProfile().supabaseAuth) {
    const { data: existingProfile } = await sb
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .maybeSingle();
    if (!existingProfile) {
      const { error: profileError } = await sb.from("profiles").insert({
        id: userId,
        role: portalRole,
        full_name: cleanEmail.split("@")[0],
        email: cleanEmail,
      } as never);
      if (profileError)
        throw new Error(`Could not create the profile for ${cleanEmail}: ${profileError.message}`);
    }
  }

  const { error } = await sb
    .from("tenant_memberships")
    .upsert(
      {
        tenant_id: tenantId,
        user_id: userId,
        role,
        status: "active",
        // Empty array on re-add so a previously-disabled member with stale perms
        // doesn't get a free permission re-grant from a re-invite.
        permissions: extraPermissions as never,
      },
      { onConflict: "tenant_id,user_id" },
    );
  if (error) throw new Error(`Could not add member: ${error.message}`);

  // Tell the colleague they have been added.
  //
  // On the SaaS that is a one-click magic link. On a self-hosted box a magic
  // link cannot work — there is no auth server to redeem it — so the email
  // carries the temporary password instead, and the operator is shown that
  // password either way, because a box with no email provider is the normal
  // case and an emailed-only password reaches nobody.
  let emailed = false;
  if (created) {
    const { data: tenant } = await sb
      .from("tenants")
      .select("name")
      .eq("id", tenantId)
      .maybeSingle();
    const tenantName = (tenant as { name?: string } | null)?.name ?? "your organisation";

    if (temporaryPassword) {
      const loginUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/login`;
      const html = [
        `<p>Hi ${esc(cleanEmail.split("@")[0])},</p>`,
        `<p>You have been added to ${esc(tenantName)} on Elite Fleet Management.</p>`,
        `<p>Sign in at <a href="${esc(loginUrl)}">${esc(loginUrl)}</a> with your email address and this temporary password:</p>`,
        `<p><code>${esc(temporaryPassword)}</code></p>`,
        `<p>Change it under Settings &rarr; Password once you are in.</p>`,
      ].join("");
      const res = await sendTenantEmail(
        tenantId,
        cleanEmail,
        `Your sign-in details for ${tenantName}`,
        html,
      );
      emailed = res.sent;
    } else {
      emailed = await sendSigninInvite(sb, cleanEmail, {
        subject: `You've been added to ${tenantName} on Elite Fleet Management`,
        heading: `You're on the team at ${tenantName}`,
        body: `You've been given access to ${tenantName}'s fleet workspace on Elite Fleet Management. Click below to sign in — no separate sign-up needed.`,
      });
    }
  }

  await audit(
    sb,
    tenantId,
    "member.added",
    tenantId,
    { email: cleanEmail, role, created },
    actor,
  );
  return { created, emailed, userId, temporaryPassword, existingAccount: !created };
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

/**
 * List every tenant in the system. Used by the daily automation run to
 * walk all tenants and run the rent-overdue worker against each one.
 * Returns the basic identity so the run log can show the tenant name.
 */
export async function listTenantIds(): Promise<{ id: string; name: string }[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('tenants')
    .select('id, name')
    .order('created_at');
  return (data ?? []) as { id: string; name: string }[];
}
