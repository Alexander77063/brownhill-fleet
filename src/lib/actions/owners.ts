"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import {
  attachVehicle,
  createOwner,
  detachAccount,
  detachVehicle,
  sendFirstAttachSms,
  updateOwner,
} from "@/lib/owners";

const OWNERS = "/ops/owners";
const str = (fd: FormData, k: string): string => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string): string | null => str(fd, k) || null;
const int = (fd: FormData, k: string): number | undefined => {
  const v = str(fd, k);
  return v === "" ? undefined : Number(v);
};

export async function createOwnerAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  await createOwner(ctx.tenantId, {
    name: str(formData, "name"),
    phone: str(formData, "phone"),
    email: opt(formData, "email"),
    nin: opt(formData, "nin"),
  });
  revalidatePath(OWNERS);
}

export async function updateOwnerAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  const id = str(formData, "id");
  await updateOwner(ctx.tenantId, id, {
    name: str(formData, "name") || undefined,
    email: opt(formData, "email"),
    nin: opt(formData, "nin"),
    night_from: str(formData, "night_from") || undefined,
    night_to: str(formData, "night_to") || undefined,
    timezone: str(formData, "timezone") || undefined,
    speed_limit_kph: int(formData, "speed_limit_kph"),
    offline_after_h: int(formData, "offline_after_h"),
    alerts_sms: formData.get("alerts_sms") === "on",
  });
  revalidatePath(OWNERS);
  revalidatePath(`${OWNERS}/${id}`);
}

export async function attachVehicleAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  const ownerId = str(formData, "owner_id");
  const vehicleId = str(formData, "vehicle_id");
  await attachVehicle(ctx.tenantId, ownerId, vehicleId);
  // The invite is a courtesy, never a reason for the attach to fail.
  await sendFirstAttachSms(ctx.tenantId, ownerId, vehicleId).catch((e: unknown) =>
    console.error("[owners] first-attach sms failed", e),
  );
  revalidatePath(`${OWNERS}/${ownerId}`);
  revalidatePath("/ops/fleet");
}

export async function detachVehicleAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  await detachVehicle(ctx.tenantId, str(formData, "vehicle_id"));
  revalidatePath(`${OWNERS}/${str(formData, "owner_id")}`);
  revalidatePath("/ops/fleet");
}

export async function detachAccountAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  const ownerId = str(formData, "owner_id");
  await detachAccount(ctx.tenantId, ownerId);
  revalidatePath(`${OWNERS}/${ownerId}`);
}

export async function resendInviteAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  const ownerId = str(formData, "owner_id");
  await sendFirstAttachSms(ctx.tenantId, ownerId, str(formData, "vehicle_id"));
  revalidatePath(`${OWNERS}/${ownerId}`);
}
