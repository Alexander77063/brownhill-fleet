"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import { inviteDriver } from "@/lib/ops/driver-invite";

/** Invite a driver: create/link their login + tenant membership + send an invite.
 *  Gated on drivers.write (ops role has it); tenantId comes from the server
 *  context, never the form. */
export async function inviteDriverAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("drivers.write");
  const driverId = String(formData.get("driver_id") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  await inviteDriver({
    tenantId: ctx.tenantId,
    email,
    driverId: driverId || undefined,
    newDriver: driverId ? undefined : { full_name: fullName, phone: phone || undefined },
  });

  revalidatePath("/ops/drivers");
}
