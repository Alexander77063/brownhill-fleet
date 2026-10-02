/** Per-tenant payment credentials (BYO Stripe / GoCardless).
 *
 *  Keys are read ONLY via the service client, server-side, and decrypted in
 *  process; they never reach a tenant client. Encrypted at rest with the same
 *  AES-256-GCM master key as the AI keys. Fail-closed: if a tenant hasn't set up
 *  a provider (or encryption is unavailable), collection through it is refused —
 *  it NEVER falls back to the platform's keys. */
import { createServiceClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/auth/context";
import { encryptionAvailable, openSecret, sealSecret } from "@/lib/crypto";

export type SecretKind = "stripe_secret" | "stripe_webhook" | "gocardless_token" | "gocardless_webhook";

export interface TenantPaymentStatus {
  stripeConfigured: boolean; // a stripe_secret is stored
  gocardlessConfigured: boolean; // a gocardless_token is stored
  stripeWebhookSet: boolean;
  gocardlessWebhookSet: boolean;
  stripeEnabled: boolean;
  gocardlessEnabled: boolean;
  gocardlessEnvironment: "sandbox" | "live";
  encryptionAvailable: boolean;
}

type Sb = ReturnType<typeof createServiceClient>;

export async function getTenantPaymentStatus(tenantId?: string): Promise<TenantPaymentStatus> {
  const tid = tenantId ?? (await requireTenantContext()).tenantId;
  const sb = createServiceClient();
  const [{ data: config }, { data: secrets }] = await Promise.all([
    sb.from("tenant_payment_config").select("stripe_enabled, gocardless_enabled, gocardless_environment").eq("tenant_id", tid).maybeSingle(),
    sb.from("tenant_payment_secrets").select("kind").eq("tenant_id", tid),
  ]);
  const kinds = new Set((secrets ?? []).map((s) => s.kind));
  return {
    stripeConfigured: kinds.has("stripe_secret"),
    gocardlessConfigured: kinds.has("gocardless_token"),
    stripeWebhookSet: kinds.has("stripe_webhook"),
    gocardlessWebhookSet: kinds.has("gocardless_webhook"),
    stripeEnabled: config?.stripe_enabled ?? false,
    gocardlessEnabled: config?.gocardless_enabled ?? false,
    gocardlessEnvironment: (config?.gocardless_environment as "sandbox" | "live") ?? "sandbox",
    encryptionAvailable: encryptionAvailable(),
  };
}

/** Decrypt a tenant's stored secret. Returns null when unset / not decryptable —
 *  callers must treat null as "not configured" and fail closed. */
export async function resolveTenantSecret(
  tenantId: string,
  kind: SecretKind,
  sb: Sb = createServiceClient(),
): Promise<string | null> {
  if (!encryptionAvailable()) return null;
  const { data } = await sb
    .from("tenant_payment_secrets")
    .select("ciphertext, iv, auth_tag")
    .eq("tenant_id", tenantId)
    .eq("kind", kind)
    .maybeSingle();
  if (!data) return null;
  return openSecret({ ciphertext: data.ciphertext, iv: data.iv, authTag: data.auth_tag });
}

/** Store a tenant secret (seal + upsert). Auth is enforced by the calling action. */
export async function saveTenantSecret(tenantId: string, kind: SecretKind, plaintext: string): Promise<void> {
  const sealed = sealSecret(plaintext.trim());
  if (!sealed) {
    throw new Error(
      "Payment encryption isn't configured on this server (TENANT_AI_ENC_KEY). Your key was NOT saved — contact your platform operator.",
    );
  }
  const sb = createServiceClient();
  await sb.from("tenant_payment_secrets").upsert(
    {
      tenant_id: tenantId,
      kind,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      auth_tag: sealed.authTag,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,kind" },
  );
}

export async function clearTenantSecret(tenantId: string, kind: SecretKind): Promise<void> {
  const sb = createServiceClient();
  await sb.from("tenant_payment_secrets").delete().eq("tenant_id", tenantId).eq("kind", kind);
}

export async function saveTenantPaymentConfig(
  tenantId: string,
  patch: { stripe_enabled?: boolean; gocardless_enabled?: boolean; gocardless_environment?: "sandbox" | "live" },
  userId: string,
): Promise<void> {
  const sb = createServiceClient();
  await sb.from("tenant_payment_config").upsert(
    { tenant_id: tenantId, ...patch, updated_at: new Date().toISOString(), updated_by: userId },
    { onConflict: "tenant_id" },
  );
}
