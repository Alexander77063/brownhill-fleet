"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/context";
import { createServiceClient } from "@/lib/supabase/server";
import { updateTenantSettings } from "@/lib/tenancy";
import { onboardSubscriber } from "@/lib/platform/onboard";
import { sendReminderNow, type ReminderKind } from "@/lib/platform/reminders";

const OVERVIEW = "/platform";
const SUBSCRIBERS = "/platform/subscribers";
const REQUESTS = "/platform/requests";

function revalidateConsole(tenantId?: string): void {
  revalidatePath(OVERVIEW);
  revalidatePath(SUBSCRIBERS);
  if (tenantId) revalidatePath(`${SUBSCRIBERS}/${tenantId}`);
}

/** Derive a valid tenant slug from a company name (matches createTenant's rule). */
function slugFromCompany(company: string, suffix: string): string {
  const base = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const stem = base.length >= 2 ? base : "tenant";
  return `${stem}-${suffix}`;
}

/** Create a new subscriber: tenant + owner account (+ optional starting plan). */
export async function onboardSubscriberAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const planId = String(formData.get("plan_id") ?? "").trim();
  await onboardSubscriber({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    ownerEmail: String(formData.get("owner_email") ?? ""),
    planId: planId || undefined,
  });
  revalidateConsole();
}

const SUB_STATUSES = new Set(["trialing", "active", "past_due", "cancelled"]);

/** Set the canonical subscription status on tenant_subscription. */
export async function setSubscriptionStatusAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!tenantId || !SUB_STATUSES.has(status)) throw new Error("Invalid subscription status.");
  const sb = createServiceClient();
  await sb
    .from("tenant_subscription")
    .upsert({ tenant_id: tenantId, status }, { onConflict: "tenant_id" });
  revalidateConsole(tenantId);
}

/** Set (or clear) the current billing-period end / renewal date. */
export async function setRenewalDateAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!tenantId) throw new Error("A tenant is required.");
  const raw = String(formData.get("period_end") ?? "").trim();
  const periodEnd = raw ? new Date(raw).toISOString() : null;
  const sb = createServiceClient();
  await sb
    .from("tenant_subscription")
    .upsert({ tenant_id: tenantId, current_period_end: periodEnd }, { onConflict: "tenant_id" });
  revalidateConsole(tenantId);
}

const TENANT_STATUSES = new Set(["active", "suspended", "cancelled"]);

/** Change the tenant lifecycle (suspend / reactivate / cancel). Audit-logged. */
export async function setTenantLifecycleAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const tenantStatus = String(formData.get("tenant_status") ?? "");
  if (!tenantId || !TENANT_STATUSES.has(tenantStatus)) throw new Error("Invalid tenant status.");
  await updateTenantSettings(tenantId, { status: tenantStatus as "active" | "suspended" | "cancelled" }, userId);
  revalidateConsole(tenantId);
}

/** Manually dispatch a reminder to a subscriber's owner. */
export async function sendReminderNowAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const kind = String(formData.get("kind") ?? "") as ReminderKind;
  if (!tenantId || !["renewal_upcoming", "trial_ending", "past_due"].includes(kind)) {
    throw new Error("Invalid reminder request.");
  }
  await sendReminderNow(tenantId, kind);
  revalidateConsole(tenantId);
}

/** Approve a pending signup request → onboard the tenant + owner, mark approved. */
export async function approveSignupRequestAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("A request id is required.");
  const sb = createServiceClient();
  const { data: reqRow } = await sb
    .from("tenant_signup_requests")
    .select("id, company, email, status")
    .eq("id", id)
    .maybeSingle();
  if (!reqRow) throw new Error("Request not found.");
  if (reqRow.status !== "pending") throw new Error("This request has already been reviewed.");

  const suffix = id.replace(/-/g, "").slice(0, 6);
  const { tenantId } = await onboardSubscriber({
    name: reqRow.company,
    slug: slugFromCompany(reqRow.company, suffix),
    ownerEmail: reqRow.email,
  });

  await sb
    .from("tenant_signup_requests")
    .update({ status: "approved", tenant_id: tenantId, reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq("id", id);

  revalidatePath(REQUESTS);
  revalidateConsole();
}

/** Reject a pending signup request. */
export async function rejectSignupRequestAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("A request id is required.");
  const sb = createServiceClient();
  await sb
    .from("tenant_signup_requests")
    .update({ status: "rejected", reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");
  revalidatePath(REQUESTS);
}
