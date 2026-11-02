/**
 * Invite a driver — the missing link that lets a driver actually log in.
 *
 * A `drivers` row alone can't sign in: the driver portal resolves the logged-in
 * user to their driver record via `profiles.driver_id`, and nothing else in
 * the app ever sets that column. This flow creates (or reuses) the driver's
 * auth account, sets `profiles.driver_id` + the `driver` role, gives them a
 * tenant membership, and emails the temp password.
 *
 * ## Where the account comes from
 *
 * Two deployments, two account stores, and the difference decides whether the
 * invite works at all:
 *
 *   * `saas` — Supabase Auth owns the account. `auth.admin.createUser` makes
 *     it, and the driver signs in with a magic link.
 *   * `hosted` / `standalone` — there is no Supabase Auth. The account is a
 *     row in the local `auth.users` table with its credential in
 *     `auth.local_credentials`, and the driver signs in with a password.
 *
 * The account used to be created the SECOND way on both. On the SaaS that
 * meant writing to a table that does not exist there, so every invite threw.
 * On a self-hosted box it meant writing a column — `email_confirmed_at` — that
 * the shim's `auth.users` does not have either, so that write threw AFTER the
 * account was created and BEFORE the profile was linked. Every invited driver
 * was left with an account nobody could sign in to, and no membership.
 *
 * ## The password the operator is given
 *
 * A self-hosted box usually has no email provider, so a password that only
 * ever travels by email reaches nobody. The password is therefore returned to
 * the operator as well as emailed, and shown to them once.
 *
 * ## An account that belongs to nobody
 *
 * The failed invite above left accounts behind: an `auth.users` row, a
 * credential nobody knows, and no membership. The operator's only way back in
 * was to try again — and the flow refused, saying the address "already
 * belongs to another account", because the account had no membership to find.
 *
 * So an account that belongs to NO tenant is adopted: linked to the driver,
 * given a membership, and handed a password that works. An account that
 * belongs to ANOTHER tenant is still refused — taking it over would move
 * somebody out of the portal they already belong to.
 */
import { createServiceClient } from "@/lib/supabase/server";
import { sendTenantEmail } from "@/lib/email/tenant-email";
import { sendEmail } from "@/lib/notify";
import { getBranding, brandDisplayName, brandEmailFrom } from "@/lib/branding";
import { createLocalUser, setLocalPassword } from "@/lib/auth/local-store";
import { generateTemporaryPassword } from "@/lib/auth/password-reset";
import { localDb } from "@/lib/db/local";
import { deploymentProfile } from "@/lib/deployment/profile";
import { esc, sendSigninInvite } from "@/lib/invite-email";

type Sb = ReturnType<typeof createServiceClient>;

/**
 * The password a newly invited driver signs in with.
 *
 * The same generator the operator's password reset uses — one policy for every
 * temporary password the product hands out, and one place that decides what
 * those passwords look like. The alphabet avoids the characters people confuse
 * when reading them aloud, because this one is often read out over the phone.
 */
function genTempPassword(): string {
  return generateTemporaryPassword();
}

/**
 * Find an existing auth account by email.
 *
 * The `profiles` row is the mirror of the account in both deployments: the
 * `handle_new_user` trigger creates it from the account row and copies the
 * email across, so it is an exact index of "which account has this address".
 * The local `auth.users` table is the fallback for a self-hosted box, where an
 * account can exist without a profile (the sign-up trigger fires on insert, so
 * it takes a direct write to make one without one).
 */
async function findUserIdByEmail(email: string, sb: Sb): Promise<string | null> {
  const clean = email.toLowerCase();

  const { data: profile } = await sb
    .from("profiles")
    .select("id")
    .eq("email", clean)
    .maybeSingle();
  if (profile) return (profile as { id: string }).id;

  if (deploymentProfile().supabaseAuth) return null;

  const db = await localDb();
  const rows = (await db`
    select id from auth.users where email = ${clean} limit 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Create the account for a driver who does not have one.
 *
 * On the SaaS, Supabase Auth owns it and the driver signs in with a magic
 * link, so there is no password to hand over. On a self-hosted box the
 * password is minted here and given to the operator.
 */
async function createAuthAccount(
  sb: Sb,
  email: string,
  fullName: string,
): Promise<{ userId: string; temporaryPassword?: string }> {
  if (deploymentProfile().supabaseAuth) {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { role: "driver", full_name: fullName },
    });
    if (error || !data?.user) {
      throw new Error(
        `Could not create the driver's login: ${error?.message ?? "unknown error"}`,
      );
    }
    return { userId: data.user.id };
  }

  const temporaryPassword = genTempPassword();
  const created = await createLocalUser(email, temporaryPassword, {
    role: "driver",
    fullName,
  });
  return { userId: created.id, temporaryPassword };
}

export interface InviteDriverInput {
  tenantId: string;
  driverId?: string;
  newDriver?: { full_name: string; phone?: string };
  email: string;
}

export interface InviteDriverResult {
  driverId: string;
  userId: string;
  /** True when this call created the account. */
  created: boolean;
  /** True when a welcome email actually went out. */
  emailed: boolean;
  /**
   * The password the driver signs in with, when this deployment issues one.
   *
   * Set on a self-hosted deployment, which signs its own sessions and usually
   * has no email provider to send it to. Shown to the operator once.
   */
  temporaryPassword?: string;
}

export async function inviteDriver(
  input: InviteDriverInput,
  _sb: Sb = createServiceClient(),
): Promise<InviteDriverResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("A login email is required to invite a driver.");

  // 1. Resolve or create the driver record. supabase-js -> PostgREST, fine.
  const sb = _sb;
  let driverId = input.driverId ?? null;
  let fullName = input.newDriver?.full_name?.trim() ?? "";
  if (driverId) {
    const { data: existing } = await sb
      .from("drivers")
      .select("id, full_name")
      .eq("id", driverId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (!existing) throw new Error("Driver not found.");
    fullName = existing.full_name;
    await sb.from("drivers").update({ email }).eq("id", driverId).eq("tenant_id", input.tenantId);
  } else {
    if (!fullName) throw new Error("A driver name is required.");
    const { data: dupes } = await sb
      .from("drivers")
      .select("id, full_name")
      .eq("tenant_id", input.tenantId)
      .eq("email", email)
      .limit(1);
    const dupe = dupes?.[0];
    if (dupe) {
      driverId = dupe.id;
      fullName = dupe.full_name || fullName;
    } else {
      const { data: created, error } = await sb
        .from("drivers")
        .insert({
          tenant_id: input.tenantId,
          full_name: fullName,
          email,
          phone: input.newDriver?.phone ?? null,
          status: "active",
        } as never)
        .select("id")
        .single();
      if (error || !created) throw new Error(`Could not create driver: ${error?.message ?? "unknown"}`);
      driverId = (created as { id: string }).id;
    }
  }

  // 2. Find or create the auth account.
  let userId = await findUserIdByEmail(email, sb);
  let created = false;
  let temporaryPassword: string | undefined;

  if (!userId) {
    const account = await createAuthAccount(sb, email, fullName);
    userId = account.userId;
    temporaryPassword = account.temporaryPassword;
    created = true;
  } else {
    // The matched account is GLOBAL, so it can already belong to somebody else.
    // Two things make that a problem, and both are checked before anything is
    // written:
    //
    //   * a membership in another tenant — the person works for somebody else,
    //     and linking them here would take them out of the portal they belong
    //     to and into this one;
    //   * a driver record in another tenant — `profiles.driver_id` is a single
    //     global column, so repointing it would hand them this tenant's driver
    //     data.
    //
    // An account with NEITHER is nobody's: it is the account an earlier failed
    // invite left behind. It is adopted rather than refused, because refusing
    // would leave the operator with a driver they can never invite.
    const { data: memberships } = await sb
      .from("tenant_memberships")
      .select("tenant_id")
      .eq("user_id", userId);
    const membershipRows = (memberships ?? []) as Array<{ tenant_id: string }>;

    const elsewhere = membershipRows.some((m) => m.tenant_id !== input.tenantId);
    if (elsewhere) {
      throw new Error(
        "That email already belongs to another account. Use a different email for this driver.",
      );
    }

    const { data: profile } = await sb
      .from("profiles")
      .select("driver_id")
      .eq("id", userId)
      .maybeSingle();
    const linkedDriverId = (profile as { driver_id: string | null } | null)?.driver_id ?? null;
    if (linkedDriverId) {
      const { data: linked } = await sb
        .from("drivers")
        .select("id, tenant_id")
        .eq("id", linkedDriverId)
        .maybeSingle();
      const linkedTenant = (linked as { tenant_id: string } | null)?.tenant_id ?? null;
      if (linkedTenant && linkedTenant !== input.tenantId) {
        throw new Error(
          "That email already belongs to another account. Use a different email for this driver.",
        );
      }
    }

    // Nobody's account: adopt it. The credential it has is one nobody knows —
    // it was the password of the invite that failed — so it is replaced with
    // one the operator is handed.
    if (membershipRows.length === 0 && !deploymentProfile().supabaseAuth) {
      temporaryPassword = genTempPassword();
      await setLocalPassword(userId, temporaryPassword);
    }
  }

  // 3. The critical link: point the profile at the driver record + driver role.
  //    `handle_new_user` already created the profile on user insert.
  await sb.from("profiles").update({ driver_id: driverId, role: "driver" }).eq("id", userId);

  // 4. Tenant membership so RLS + portal access resolve.
  await sb
    .from("tenant_memberships")
    .upsert(
      { tenant_id: input.tenantId, user_id: userId, role: "driver", status: "active" },
      { onConflict: "tenant_id,user_id" },
    );

  // 5. Tell the driver. Two ways, because the two deployments can do
  // different things:
  //
  //   * the SaaS has Supabase Auth, so it sends a one-click sign-in link —
  //     there is no password to email;
  //   * a self-hosted box signs its own sessions, so it emails the temporary
  //     password and the operator is given it too, because the box usually
  //     has no email provider to send it to.
  //
  // Prefer the tenant's own email (BYO), but onboarding shouldn't wait on the
  // tenant finishing email setup — fall back to the platform for the one-off
  // welcome.
  const branding = await getBranding(input.tenantId);
  const brand = brandDisplayName(branding);
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/driver/login`
    : "/driver/login";
  const subject = `You've been added to ${brand}`;

  let emailed = false;
  if (deploymentProfile().supabaseAuth) {
    emailed = await sendSigninInvite(sb, email, {
      subject,
      heading: `Welcome to ${brand}`,
      body: `${brand} has set up your driver account. Sign in to see your agreement, documents, charges and payments.`,
    });
  } else {
    const passwordLine = temporaryPassword
      ? `<p>Your temporary password is <code>${esc(temporaryPassword)}</code>. Sign in at <a href="${esc(loginUrl)}">${esc(loginUrl)}</a> and change it under Settings -&gt; Password once you're in.</p>`
      : "";
    const html = `<p>Hi ${esc(fullName || "there")},</p><p>${esc(brand)} has set up your driver account.</p>${passwordLine}<p>Once signed in, you can see your agreement, documents, charges and payments.</p>`;

    let res = await sendTenantEmail(input.tenantId, email, subject, html);
    if (res.skipped) {
      const platformFrom = process.env.NOTIFY_FROM_EMAIL || "Elite Fleet Management <fleet@elitefleetmanagement.co.uk>";
      res = await sendEmail(email, subject, html, brandEmailFrom(branding, platformFrom));
    }
    emailed = res.sent;
  }

  return {
    driverId: driverId as string,
    userId,
    created,
    emailed,
    temporaryPassword,
  };
}
