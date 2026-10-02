"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import {
  saveTenantSecret,
  clearTenantSecret,
  saveTenantPaymentConfig,
} from "@/lib/payments/tenant-credentials";

const SETTINGS = "/admin/payments";

/** Save the tenant's OWN Stripe secret + webhook secret and enable flag.
 *  Fail-closed: these credentials are the tenant's own — the platform env keys
 *  are NEVER used for a tenant's rent/charge collection. Gated to tenant admins. */
export async function saveStripeKeyAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  const secret = String(formData.get("stripe_secret") ?? "").trim();
  const webhook = String(formData.get("stripe_webhook") ?? "").trim();
  if (secret) await saveTenantSecret(ctx.tenantId, "stripe_secret", secret);
  if (webhook) await saveTenantSecret(ctx.tenantId, "stripe_webhook", webhook);
  await saveTenantPaymentConfig(
    ctx.tenantId,
    { stripe_enabled: formData.get("stripe_enabled") === "on" },
    ctx.userId,
  );
  revalidatePath(SETTINGS);
}

/** Save the tenant's OWN GoCardless access token + webhook secret, environment
 *  and enable flag. Same fail-closed rule as Stripe. */
export async function saveGoCardlessKeyAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  const token = String(formData.get("gocardless_token") ?? "").trim();
  const webhook = String(formData.get("gocardless_webhook") ?? "").trim();
  if (token) await saveTenantSecret(ctx.tenantId, "gocardless_token", token);
  if (webhook) await saveTenantSecret(ctx.tenantId, "gocardless_webhook", webhook);
  const environment = formData.get("gocardless_environment") === "live" ? "live" : "sandbox";
  await saveTenantPaymentConfig(
    ctx.tenantId,
    {
      gocardless_enabled: formData.get("gocardless_enabled") === "on",
      gocardless_environment: environment,
    },
    ctx.userId,
  );
  revalidatePath(SETTINGS);
}

/** Disconnect Stripe: remove the stored secret + webhook and disable collection. */
export async function clearStripeAction(): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  await clearTenantSecret(ctx.tenantId, "stripe_secret");
  await clearTenantSecret(ctx.tenantId, "stripe_webhook");
  await saveTenantPaymentConfig(ctx.tenantId, { stripe_enabled: false }, ctx.userId);
  revalidatePath(SETTINGS);
}

/** Disconnect GoCardless: remove the stored token + webhook and disable collection. */
export async function clearGoCardlessAction(): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  await clearTenantSecret(ctx.tenantId, "gocardless_token");
  await clearTenantSecret(ctx.tenantId, "gocardless_webhook");
  await saveTenantPaymentConfig(ctx.tenantId, { gocardless_enabled: false }, ctx.userId);
  revalidatePath(SETTINGS);
}
