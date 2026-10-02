/** Onboard a new subscriber (tenant + owner) from the operator console.
 *
 *  Mirrors the create-user → profile → tenant sequence proven by
 *  scripts/bootstrap-owner.mjs: resolve (or create) the owner's auth user — the
 *  `handle_new_user` trigger provisions the profiles row — then `createTenant`
 *  (owner membership + trial subscription) and optionally set a starting plan.
 */
import { createServiceClient } from "@/lib/supabase/server";
import { createTenant } from "@/lib/tenancy";
import { setTenantPlan } from "@/lib/catalogue/manage";
import { sendEmail } from "@/lib/notify";

/** Email a newly-onboarded owner a branded, one-click magic sign-in link (falls back
 *  to the login page). Best-effort — a welcome-email failure must NEVER block or fail
 *  onboarding, and it no-ops when the platform email/app-url aren't configured. */
async function sendOwnerWelcome(
  sb: ReturnType<typeof createServiceClient>,
  ownerEmail: string,
  tenantName: string,
): Promise<void> {
  try {
    const base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    if (!base) return;
    const { data, error } = await sb.auth.admin.generateLink({
      type: "magiclink",
      email: ownerEmail,
      options: { redirectTo: `${base}/auth/confirm?next=/ops` },
    });
    const hashed = data?.properties?.hashed_token;
    if (error || !hashed) return;
    const link = `${base}/auth/confirm?token_hash=${encodeURIComponent(hashed)}&type=magiclink&next=${encodeURIComponent("/ops")}`;
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1a2438">
        <h1 style="font-size:20px;color:#0a1628">Welcome to Elite Fleet Management</h1>
        <p>Your workspace for <strong>${tenantName}</strong> is ready. Click below to sign in and finish setting up your fleet — vehicles, drivers, agreements and payments, all under your own brand.</p>
        <p style="margin:24px 0">
          <a href="${link}" style="background:#c9a94a;color:#0a1628;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:9px;display:inline-block">Sign in &amp; set up your fleet</a>
        </p>
        <p style="font-size:13px;color:#6b7688">This secure link signs you in as <strong>${ownerEmail}</strong>. If it has expired, go to <a href="${base}/login">${base}/login</a> and use “Email link” with this address.</p>
        <p style="font-size:12px;color:#8a97a8;border-top:1px solid #eee;padding-top:12px;margin-top:24px">Elite Fleet Management is operated by Elite Solutions Hub Ltd.</p>
      </div>`;
    await sendEmail(ownerEmail, "Welcome to Elite Fleet Management — sign in to set up your fleet", html);
  } catch {
    // never fail onboarding on a welcome email
  }
}

async function findUserByEmail(sb: ReturnType<typeof createServiceClient>, email: string) {
  const target = email.trim().toLowerCase();
  // Page through admin users (small deployments; 200/page is plenty here).
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    const match = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (match) return match;
    if (data.users.length < 200) break;
  }
  return null;
}

export async function onboardSubscriber(
  input: { name: string; slug: string; ownerEmail: string; planId?: string },
  sb: ReturnType<typeof createServiceClient> = createServiceClient(),
): Promise<{ tenantId: string; ownerUserId: string; created: boolean }> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!name) throw new Error("A subscriber name is required.");
  if (!ownerEmail) throw new Error("An owner email is required.");

  let user = await findUserByEmail(sb, ownerEmail);
  let created = false;
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email: ownerEmail,
      email_confirm: true,
      user_metadata: { role: "ops", full_name: `${name} Owner` },
    });
    if (error || !data.user) throw new Error(`Could not create owner account: ${error?.message ?? "unknown error"}`);
    user = data.user;
    created = true;
  }

  // createTenant validates the slug, creates the tenant + owner membership + a
  // trial tenant_subscription, and audit-logs the action.
  const { id: tenantId } = await createTenant({ name, slug }, user.id);

  if (input.planId) {
    // SaaS onboarding (Supabase Auth builds only): activates without an invoice,
    // exactly as before NG-2. Pay-first markets never reach this function.
    await setTenantPlan(tenantId, input.planId, sb, { status: "active", allowUnpriced: true });
  }

  // Send the owner a branded sign-in link so they land in the app, not on /login.
  await sendOwnerWelcome(sb, ownerEmail, name);

  return { tenantId, ownerUserId: user.id, created };
}
