/** Per-tenant AI assistant ("Fleet Assistant"). Bundled with tenancy, BYO key.
 *
 *  Isolation guarantees:
 *   - The API key is read only via the service client, server-side, and decrypted
 *     in-process; it never reaches a tenant client.
 *   - Grounding data comes from the RLS query helpers (getFleetEconomics /
 *     getObligations), which run on the cookie-based RLS client — so the model
 *     only ever sees THIS tenant's own fleet, never another tenant's.
 *  This is a different surface, persona, and data boundary from the platform
 *  operator copilot (which is cross-tenant and platform-admin only).
 */
import { createServiceClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/auth/context";
import { encryptionAvailable, openSecret, sealSecret } from "@/lib/crypto";
import { aiComplete, aiConfigured } from "@/lib/ai";
import { getPlatformAiBudget, recordPlatformTokens } from "@/lib/ai/usage";

// Platform-AI model tiers (used only when a tenant has no BYO key): a fast, cheap
// model for interactive chat, a stronger one for long-form report generation.
export const PLATFORM_CHAT_MODEL = "claude-haiku-4-5-20251001";
export const PLATFORM_REPORT_MODEL = "claude-sonnet-5";
import {
  AI_PROVIDERS,
  defaultModelFor,
  isAiProvider,
  providerComplete,
  type AiMessage,
  type AiProvider,
} from "@/lib/ai/providers";

export interface TenantAiStatus {
  provider: AiProvider;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  encryptionAvailable: boolean;
  /** True when the assistant can actually answer (via BYO key OR the platform AI). */
  ready: boolean;
  /** The tenant is answered by the platform AI (no BYO key, but included in plan). */
  usingPlatform: boolean;
  /** The platform AI account is configured on this deployment. */
  platformAvailable: boolean;
  /** The tenant's plan includes the platform AI. */
  entitled: boolean;
  /** The platform-AI monthly budget is not yet exhausted. */
  withinBudget: boolean;
  /** Platform-AI tokens used this month, and the plan cap (null = unlimited). */
  platformUsed: number;
  platformLimit: number | null;
}

export async function getTenantAiStatus(): Promise<TenantAiStatus> {
  const { tenantId } = await requireTenantContext();
  const sb = createServiceClient();
  const [{ data: config }, { count }] = await Promise.all([
    sb.from("tenant_ai_config").select("provider, model, enabled").eq("tenant_id", tenantId).maybeSingle(),
    sb.from("tenant_ai_secrets").select("tenant_id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);
  const provider = (config?.provider && isAiProvider(config.provider) ? config.provider : "anthropic") as AiProvider;
  const hasKey = (count ?? 0) > 0;
  const encAvail = encryptionAvailable();
  const enabled = config?.enabled ?? false;
  const byoReady = enabled && hasKey && encAvail;

  // Platform fallback: no BYO key, but the platform AI is configured and the plan
  // includes it (within budget).
  const platformAvailable = aiConfigured();
  const budget = !byoReady && platformAvailable ? await getPlatformAiBudget(tenantId) : null;
  const usingPlatform = !byoReady && platformAvailable && !!budget?.entitled;

  return {
    provider,
    model: config?.model || defaultModelFor(provider),
    enabled,
    hasKey,
    encryptionAvailable: encAvail,
    ready: byoReady || (usingPlatform && (budget?.withinBudget ?? false)),
    usingPlatform,
    platformAvailable,
    entitled: budget?.entitled ?? false,
    withinBudget: budget?.withinBudget ?? false,
    platformUsed: budget?.used ?? 0,
    platformLimit: budget?.limit ?? null,
  };
}

/** Save the tenant's assistant config. Auth is enforced by the calling action.
 *  A blank apiKey leaves the existing key untouched; a non-blank one re-seals it. */
export async function saveTenantAiConfig(
  input: { provider: AiProvider; model: string; enabled: boolean; apiKey?: string },
  tenantId: string,
  userId: string,
): Promise<void> {
  const sb = createServiceClient();
  const { data: existing } = await sb
    .from("tenant_ai_config")
    .select("provider")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const apiKey = input.apiKey?.trim();
  // A stored key belongs to the provider it was entered for. If the provider is
  // being changed and no fresh key is supplied, the old key would be sent to the
  // NEW provider's host — a credential leak. So on a provider change without a new
  // key we drop the stale key and force the assistant off until a new one is added.
  const providerChanged = !!existing?.provider && existing.provider !== input.provider;
  const enabled = providerChanged && !apiKey ? false : input.enabled;

  await sb.from("tenant_ai_config").upsert(
    {
      tenant_id: tenantId,
      provider: input.provider,
      model: input.model || defaultModelFor(input.provider),
      enabled,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    },
    { onConflict: "tenant_id" },
  );

  if (apiKey) {
    const sealed = sealSecret(apiKey);
    if (!sealed) {
      throw new Error(
        "AI encryption isn't configured on this server (TENANT_AI_ENC_KEY). Your key was NOT saved — contact your platform operator.",
      );
    }
    await sb.from("tenant_ai_secrets").upsert(
      {
        tenant_id: tenantId,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        auth_tag: sealed.authTag,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id" },
    );
  } else if (providerChanged) {
    await sb.from("tenant_ai_secrets").delete().eq("tenant_id", tenantId);
  }
}

/** Remove the stored key (and disable the assistant). */
export async function clearTenantAiKey(tenantId: string): Promise<void> {
  const sb = createServiceClient();
  await sb.from("tenant_ai_secrets").delete().eq("tenant_id", tenantId);
  await sb.from("tenant_ai_config").update({ enabled: false }).eq("tenant_id", tenantId);
}

export class AssistantNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantNotReadyError";
  }
}

const SYSTEM = `You are the in-account Fleet Assistant for a vehicle-rental operator using Elite Fleet Management. You work for THIS operator only and only ever see their own fleet data — never any other company's.

You are given a JSON snapshot of the operator's own vehicles (economics, occupancy, status) and their open compliance obligations. Ground every answer in that data — quote real registrations, figures, and dates. Money is integer pence; present it as GBP (e.g. 82500 → £825.00).

Be concise, practical, and specific to a UK private-hire / rental operation. Help with: which vehicles are underperforming, upcoming MOT/insurance/PCO/DVLA compliance, occupancy and revenue optimisation, and day-to-day fleet decisions. If the data doesn't support an answer, say so rather than inventing numbers.`;

function pence(p: number | null | undefined): string {
  return `£${((p ?? 0) / 100).toFixed(2)}`;
}

/** Build a compact grounding snapshot pinned to the ACTIVE tenant only.
 *
 *  The shared RLS query helpers scope by is_tenant_member(), which returns rows
 *  for EVERY tenant the user belongs to — so for a multi-tenant user they would
 *  blend other tenants' fleets into the snapshot sent to THIS tenant's external
 *  provider. We therefore query the service client with an explicit tenant_id
 *  filter, guaranteeing the snapshot matches the tenant whose key is being used. */
async function buildTenantSnapshot(tenantId: string): Promise<string> {
  const sb = createServiceClient();
  const { data: ownVehicles } = await sb.from("vehicles").select("id").eq("tenant_id", tenantId);
  const vehicleIds = (ownVehicles ?? []).map((v) => v.id);

  const [econRes, oblRes] = await Promise.all([
    vehicleIds.length
      ? sb
          .from("v_vehicle_economics_all")
          .select(
            "registration, status, occupancy_12m_pct, contracted_annual_net_pence, contracted_annual_profit_pence, net_received_to_date_pence",
          )
          .in("vehicle_id", vehicleIds)
      : Promise.resolve({ data: [] as never[] }),
    sb
      .from("obligations")
      .select("type, title, due_date, status, severity")
      .eq("tenant_id", tenantId)
      .neq("status", "resolved")
      .limit(60),
  ]);

  const fleet = (econRes.data ?? []) as {
    registration: string;
    status: string;
    occupancy_12m_pct: number | null;
    contracted_annual_net_pence: number | null;
    contracted_annual_profit_pence: number | null;
    net_received_to_date_pence: number | null;
  }[];
  const obligations = (oblRes.data ?? []) as {
    type: string;
    title: string;
    due_date: string;
    status: string;
    severity: string;
  }[];

  const snapshot = {
    fleet: fleet.slice(0, 60).map((v) => ({
      registration: v.registration,
      status: v.status,
      occupancy12mPct: v.occupancy_12m_pct ?? null,
      annualNet: pence(v.contracted_annual_net_pence ?? 0),
      annualProfit: pence(v.contracted_annual_profit_pence ?? 0),
      receivedToDate: pence(v.net_received_to_date_pence ?? 0),
    })),
    openObligations: obligations.map((o) => ({
      type: o.type,
      title: o.title,
      due: o.due_date,
      status: o.status,
      severity: o.severity,
    })),
  };
  return JSON.stringify(snapshot, null, 2);
}

/** Answer a question grounded in the tenant's own data with their own provider/key. */
/** Resolve the tenant's AI config + decrypted key and run one completion with the
 *  tenant's own provider. Shared by the chat assistant and the report generator.
 *  Throws AssistantNotReadyError when the assistant is dormant/misconfigured. */
export async function runTenantAi(
  tenantId: string,
  system: string,
  messages: AiMessage[],
  maxTokens = 1500,
  opts: { platformModel?: string } = {},
): Promise<string> {
  const sb = createServiceClient();

  // Prefer the tenant's OWN key when they've configured and enabled one (billed to
  // their own provider account; not metered by us).
  if (encryptionAvailable()) {
    const [{ data: config }, { data: secret }] = await Promise.all([
      sb.from("tenant_ai_config").select("provider, model, enabled").eq("tenant_id", tenantId).maybeSingle(),
      sb.from("tenant_ai_secrets").select("ciphertext, iv, auth_tag").eq("tenant_id", tenantId).maybeSingle(),
    ]);
    if (config?.enabled && secret) {
      const apiKey = openSecret({ ciphertext: secret.ciphertext, iv: secret.iv, authTag: secret.auth_tag });
      if (apiKey) {
        const provider = (isAiProvider(config.provider) ? config.provider : "anthropic") as AiProvider;
        const model = config.model || defaultModelFor(provider);
        const { text } = await providerComplete({ provider, apiKey, model, system, messages, maxTokens });
        return text;
      }
      // The tenant deliberately configured their own key but it can't be read —
      // surface that rather than silently billing them to the platform allowance.
      throw new AssistantNotReadyError("Your saved API key could not be read. Please re-enter it in Settings.");
    }
  }

  // Otherwise fall back to the PLATFORM AI — included with the plan, metered and
  // capped per tenant. Dormant-safe: without a platform key it stays unavailable.
  if (!aiConfigured()) {
    throw new AssistantNotReadyError("The AI assistant isn't available on this server yet.");
  }
  const budget = await getPlatformAiBudget(tenantId);
  if (!budget.entitled) {
    throw new AssistantNotReadyError("AI isn't included in your current plan. Upgrade, or add your own API key in Settings.");
  }
  if (!budget.withinBudget) {
    throw new AssistantNotReadyError(
      "You've reached this month's AI usage limit. Add your own API key in Settings to keep going, or upgrade your plan.",
    );
  }
  const { text, usage } = await aiComplete({ system, messages, maxTokens, model: opts.platformModel });
  await recordPlatformTokens(tenantId, usage.input, usage.output);
  return text;
}

export async function askTenantAssistant(question: string, history: AiMessage[] = []): Promise<string> {
  const { tenantId } = await requireTenantContext();
  const snapshot = await buildTenantSnapshot(tenantId);
  const messages: AiMessage[] = [
    ...history,
    { role: "user", content: `My fleet snapshot:\n\n${snapshot}\n\n---\n\nQuestion: ${question}` },
  ];
  return runTenantAi(tenantId, SYSTEM, messages, 1500, { platformModel: PLATFORM_CHAT_MODEL });
}

export { AI_PROVIDERS };
