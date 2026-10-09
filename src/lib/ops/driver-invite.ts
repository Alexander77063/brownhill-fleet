/**
 * Invite a driver — the missing link that lets a driver actually log in.
 *
 * A `drivers` row alone can't sign in: the driver portal resolves the logged-in
 * user to their driver record via `profiles.driver_id`, and nothing else in
 * the app ever sets that column. This flow creates (or reuses) the driver's
 * auth account, sets `profiles.driver_id` + the `driver` role, gives them a
 * tenant membership, and emails the temp password.
 *
 * For the standalone profile there is no Supabase Auth backend. We use the
 * shared `createLocalUser` helper (writes auth.users + auth.local_credentials
 * via the direct postgres connection) and set `email_confirmed_at` on the
 * auth.users row so the driver can sign in immediately.
 */
import { randomBytes } from 'node:crypto';
import { createServiceClient } from "@/lib/supabase/server";
import { sendTenantEmail } from "@/lib/email/tenant-email";
import { sendEmail } from "@/lib/notify";
import { getBranding, brandDisplayName, brandEmailFrom } from "@/lib/branding";
import { createLocalUser } from "@/lib/auth/local-store";
import { localDb } from "@/lib/db/local";

type Sb = ReturnType<typeof createServiceClient>;

function genTempPassword(): string {
  return randomBytes(18).toString("base64url").slice(0, 24);
}

/**
 * Find an existing auth user id by email via the profiles mirror. Standalone
 * equivalent of the SaaS `sb.auth.admin.listUsers` round-trip — queries the
 * local postgres directly.
 */
async function findUserIdByEmail(email: string): Promise<string | null> {
  const db = await localDb();
  const rows = (await db`
    select id from auth.users where email = ${email.toLowerCase()} limit 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
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
  created: boolean;
  emailed: boolean;
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

  // 2. Find or create the auth account via the LOCAL path.
  // The supabase-js `auth.admin.*` calls only work on the SaaS profile
  // (where the URL points at a real Supabase project). The standalone build
  // uses the local `auth.users` + `auth.local_credentials` tables; the shared
  // `createLocalUser` helper inserts both rows in a single connection.
  let userId = await findUserIdByEmail(email);
  let created = false;
  let tempPassword: string | null = null;
  if (!userId) {
    tempPassword = genTempPassword();
    const createdUser = await createLocalUser(email, tempPassword, {
      role: "driver",
      fullName,
    });
    userId = createdUser.id;
    // Mark the email as already confirmed: a driver we just invited shouldn't
    // have to round-trip through Supabase Auth's confirmation flow.
    const db = await localDb();
    await db`
      update auth.users set email_confirmed_at = now() where id = ${userId}::uuid
    `;
    created = true;
  } else {
    // The matched account is GLOBAL. Only (re)link if it ALREADY belongs to
    // this tenant; otherwise we'd hijack someone else's account by repointing
    // their profiles.driver_id (a single global column).
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
  //    `handle_new_user` already created the profile on user insert.
  await sb.from("profiles").update({ driver_id: driverId, role: "driver" }).eq("id", userId);

  // 4. Tenant membership so RLS + portal access resolve.
  await sb
    .from("tenant_memberships")
    .upsert(
      { tenant_id: input.tenantId, user_id: userId, role: "driver", status: "active" },
      { onConflict: "tenant_id,user_id" },
    );

  // 5. Invite email. Prefer the tenant's own email (BYO), but onboarding
  // shouldn't wait on the tenant finishing email setup — fall back to the
  // platform for the one-off welcome.
  const branding = await getBranding(input.tenantId);
  const brand = brandDisplayName(branding);
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/login`
    : "/login";
  const subject = `You've been added to ${brand}`;
  const passwordLine = created
    ? `<p>Your temporary password is <code>${tempPassword}</code>. Sign in at <a href="${loginUrl}">${loginUrl}</a> and change it under Settings -> Password once you're in.</p>`
    : "";
  const html = `<p>Hi ${fullName || "there"},</p><p>${brand} has set up your driver account.</p>${passwordLine}<p>Once signed in, you can see your agreement, documents, charges and payments.</p>`;

  let res = await sendTenantEmail(input.tenantId, email, subject, html);
  if (res.skipped) {
    const platformFrom = process.env.NOTIFY_FROM_EMAIL || "Elite Fleet Management <fleet@elitefleetmanagement.co.uk>";
    res = await sendEmail(email, subject, html, brandEmailFrom(branding, platformFrom));
  }

  return { driverId: driverId as string, userId, created, emailed: res.sent };
}
