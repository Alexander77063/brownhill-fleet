/** Invite a driver — the missing link that lets a driver actually log in.
 *
 *  A `drivers` row alone can't sign in: the driver portal resolves the logged-in
 *  user to their driver record via `profiles.driver_id`, and nothing else in the
 *  app ever sets that column. This flow creates (or reuses) the driver's auth
 *  account, sets `profiles.driver_id` + the `driver` role, gives them a tenant
 *  membership, and emails an invite. Uses the SERVICE client because
 *  `auth.admin.*` requires the service-role key; every write is scoped to the
 *  caller's tenantId (passed in from a permission-checked action).
 *
 *  Email is dormant-safe: without RESEND_API_KEY the send is skipped and the
 *  result reports `emailed: false` — the account + link are still created.
 */
import { createServiceClient } from "@/lib/supabase/server";
import { sendTenantEmail } from "@/lib/email/tenant-email";
import { sendEmail } from "@/lib/notify";
import { getBranding, brandDisplayName, brandEmailFrom } from "@/lib/branding";

type Sb = ReturnType<typeof createServiceClient>;

/** Find an existing auth user id by email via the profiles mirror (email is a
 *  citext column populated by the handle_new_user trigger) — reliable and indexed,
 *  unlike paginating auth.admin.listUsers (which can miss recently-created users). */
async function findUserIdByEmail(sb: Sb, email: string): Promise<string | null> {
  const { data } = await sb.from("profiles").select("id").eq("email", email).limit(1);
  return data?.[0]?.id ?? null;
}

export interface InviteDriverInput {
  tenantId: string;
  /** Link an existing driver record… */
  driverId?: string;
  /** …or create a new one. */
  newDriver?: { full_name: string; phone?: string };
  /** The login email for the driver's account (also stored on the driver row). */
  email: string;
}

export interface InviteDriverResult {
  driverId: string;
  userId: string;
  created: boolean; // was the auth account newly created?
  emailed: boolean;
}

export async function inviteDriver(
  input: InviteDriverInput,
  sb: Sb = createServiceClient(),
): Promise<InviteDriverResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("A login email is required to invite a driver.");

  // 1. Resolve or create the driver record — scoped to the caller's tenant.
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
    // keep the login email on the driver record in sync
    await sb.from("drivers").update({ email }).eq("id", driverId).eq("tenant_id", input.tenantId);
  } else {
    if (!fullName) throw new Error("A driver name is required.");
    // Reuse an existing driver with this email in THIS tenant rather than
    // creating a duplicate (re-invites, or a driver already added via import).
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
  let userId = await findUserIdByEmail(sb, email);
  let created = false;
  if (!userId) {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { role: "driver", full_name: fullName },
    });
    if (error || !data.user) throw new Error(`Could not create driver account: ${error?.message ?? "unknown"}`);
    userId = data.user.id;
    created = true;
  } else {
    // The matched account is GLOBAL (auth.users spans all tenants). Only (re)link
    // it if it ALREADY belongs to this tenant — otherwise we'd hijack someone
    // else's account: repointing their profiles.driver_id (a single global column)
    // would expose this tenant's driver data to them. Refuse instead.
    const { data: membership } = await sb
      .from("tenant_memberships")
      .select("tenant_id")
      .eq("user_id", userId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (!membership) {
      throw new Error(
        "That email already belongs to another account. Use a different email for this driver.",
      );
    }
  }

  // 3. The critical link: point the profile at the driver record + driver role.
  //    (handle_new_user created the profile on user insert; update it here.)
  await sb.from("profiles").update({ driver_id: driverId, role: "driver" }).eq("id", userId);

  // 4. Tenant membership so RLS + portal access resolve.
  await sb
    .from("tenant_memberships")
    .upsert(
      { tenant_id: input.tenantId, user_id: userId, role: "driver", status: "active" },
      { onConflict: "tenant_id,user_id" },
    );

  // 5. Invite email. Prefer the tenant's own email (BYO), but — unlike ongoing
  // reminders — onboarding shouldn't wait on the tenant finishing email setup, so
  // fall back to the platform for the one-off welcome. (Login itself is a separate
  // Supabase Auth magic link, so a missed welcome never blocks a driver.)
  const branding = await getBranding(input.tenantId);
  const brand = brandDisplayName(branding);
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/login`
    : "/login";
  const subject = `You've been added to ${brand}`;
  const html = `<p>Hi ${fullName || "there"},</p><p>${brand} has set up your driver account. Sign in with this email to see your agreement, documents, charges and payments.</p><p><a href="${loginUrl}">Open the driver portal</a> — use the "Email link" option to receive a one-time sign-in link.</p>`;

  let res = await sendTenantEmail(input.tenantId, email, subject, html);
  if (res.skipped) {
    // Tenant hasn't connected email yet — send the welcome from the platform,
    // branded with the tenant's name.
    const platformFrom = process.env.NOTIFY_FROM_EMAIL || "Elite Fleet Management <fleet@elitefleetmanagement.co.uk>";
    res = await sendEmail(email, subject, html, brandEmailFrom(branding, platformFrom));
  }

  return { driverId: driverId as string, userId, created, emailed: res.sent };
}
