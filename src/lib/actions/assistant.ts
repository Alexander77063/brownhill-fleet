"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import { saveTenantAiConfig, clearTenantAiKey } from "@/lib/ops/assistant";
import { isAiProvider, type AiProvider } from "@/lib/ai/providers";

const SETTINGS = "/ops/settings/assistant";

/** Save the tenant's Fleet Assistant config. Gated to tenant admins/owners. */
export async function saveTenantAiConfigAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  const providerRaw = String(formData.get("provider") ?? "anthropic");
  const provider: AiProvider = isAiProvider(providerRaw) ? providerRaw : "anthropic";
  await saveTenantAiConfig(
    {
      provider,
      model: String(formData.get("model") ?? "").trim(),
      enabled: formData.get("enabled") === "on",
      apiKey: String(formData.get("api_key") ?? ""),
    },
    ctx.tenantId,
    ctx.userId,
  );
  revalidatePath(SETTINGS);
  revalidatePath("/ops/assistant");
}

/** Remove the stored API key and disable the assistant. */
export async function clearTenantAiKeyAction(): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  await clearTenantAiKey(ctx.tenantId);
  revalidatePath(SETTINGS);
  revalidatePath("/ops/assistant");
}
