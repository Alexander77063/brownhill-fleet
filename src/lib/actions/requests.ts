"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { requirePermission, requirePlatformAdmin } from "@/lib/auth/context";
import {
  acknowledgeRequest,
  closeRequest,
  raiseRequestAsOwner,
  raiseRequestAsStaff,
  removeOnCall,
  upsertOnCall,
  listOnCall,
  REQUEST_KINDS,
  type RequestKind,
} from "@/lib/requests";
import { normalisePhone } from "@/lib/phone";
import { placeVoiceCall } from "@/lib/voice/platform-voice";

const str = (fd: FormData, k: string): string => String(fd.get(k) ?? "").trim();
const kindOf = (fd: FormData): RequestKind => {
  const k = str(fd, "kind") as RequestKind;
  if (!REQUEST_KINDS.includes(k)) throw new Error("Choose what you need help with.");
  return k;
};

export async function raiseOwnerRequestAction(formData: FormData): Promise<void> {
  await requireRole(["owner"]);
  await raiseRequestAsOwner({
    vehicleId: str(formData, "vehicle_id") || null,
    kind: kindOf(formData),
    note: str(formData, "note") || null,
  });
  revalidatePath("/owner/help");
  redirect("/owner/help?raised=1");
}

export async function raiseStaffRequestAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("fleet.write");
  const ownerId = str(formData, "owner_id") || null;
  await raiseRequestAsStaff(ctx.tenantId, {
    ownerId,
    vehicleId: str(formData, "vehicle_id") || null,
    kind: kindOf(formData),
    note: str(formData, "note") || null,
    raisedBy: ctx.userId,
  });
  if (ownerId) revalidatePath(`/ops/owners/${ownerId}`);
}

export async function acknowledgeRequestAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  await acknowledgeRequest(id, userId);
  revalidatePath("/platform/assistance");
  revalidatePath(`/platform/assistance/${id}`);
}

export async function closeRequestAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  const resolution = str(formData, "resolution");
  if (!resolution) throw new Error("Say what was done before closing.");
  await closeRequest(id, userId, resolution);
  revalidatePath("/platform/assistance");
  revalidatePath(`/platform/assistance/${id}`);
}

export async function upsertOnCallAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const phone = normalisePhone(str(formData, "phone"));
  if (!phone) throw new Error("Enter a valid mobile number.");
  const name = str(formData, "name");
  if (!name) throw new Error("Enter a name.");
  await upsertOnCall({
    id: str(formData, "id") || undefined,
    user_id: str(formData, "user_id") || null,
    name,
    phone,
    priority: Math.min(10, Math.max(1, Number(str(formData, "priority") || 1))),
    active: formData.get("active") !== "off",
  });
  revalidatePath("/platform/oncall");
}

export async function removeOnCallAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  await removeOnCall(str(formData, "id"));
  revalidatePath("/platform/oncall");
}

/** Place one real voice call to an on-call row, so the roster is proven before it is needed. */
export async function testCallAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = str(formData, "id");
  const row = (await listOnCall()).find((r) => r.id === id);
  if (!row) throw new Error("On-call entry not found.");
  const r = await placeVoiceCall(row.phone, `This is a test call from Fleet Management for ${row.name}. Emergency calls will sound like this.`);
  if (!r.sent) throw new Error(r.skipped ? "Voice calling is not configured (PLATFORM_TWILIO_*)." : `Call failed: ${r.error}`);
  revalidatePath("/platform/oncall");
}
