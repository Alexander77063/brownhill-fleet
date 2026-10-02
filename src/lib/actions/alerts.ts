"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import { acknowledgeAlert } from "@/lib/alerts/query";

export async function acknowledgeAlertAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  const id = String(formData.get("alert_id") ?? "");
  await acknowledgeAlert(ctx.tenantId, id, ctx.userId);
  revalidatePath("/ops/tracking");
  const ownerId = String(formData.get("owner_id") ?? "");
  if (ownerId) revalidatePath(`/ops/owners/${ownerId}`);
}
