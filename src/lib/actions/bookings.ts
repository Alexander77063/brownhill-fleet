"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import { requireEntitlement } from "@/lib/entitlements";
import {
  assignBooking,
  createBooking,
  deleteBooking,
  transitionBooking,
  type BookingStatus,
} from "@/lib/bookings";
import { pounds } from "@/lib/money";

export async function createBookingAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("bookings.write");
  await requireEntitlement("rental.core");
  await requireEntitlement("booking.b2b");
  const fare = Number(
    String(formData.get("fare") ?? "").replace(/[£,\s]/g, ""),
  );
  await createBooking(
    ctx.tenantId,
    {
      source: String(formData.get("source") ?? "dispatch") as
        | "dispatch"
        | "app"
        | "job_sheet",
      passengerName: String(formData.get("passenger_name") ?? "") || undefined,
      passengerPhone:
        String(formData.get("passenger_phone") ?? "") || undefined,
      pickup: String(formData.get("pickup") ?? ""),
      dropoff: String(formData.get("dropoff") ?? ""),
      scheduledAt: String(formData.get("scheduled_at") ?? "") || undefined,
      farePence: Number.isFinite(fare) && fare > 0 ? pounds(fare) : undefined,
      notes: String(formData.get("notes") ?? "") || undefined,
    },
    ctx.userId,
  );
  revalidatePath("/ops/bookings");
}

export async function assignBookingAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("bookings.write");
  await requireEntitlement("rental.core");
  await requireEntitlement("booking.b2b");
  await assignBooking(
    ctx.tenantId,
    String(formData.get("booking_id") ?? ""),
    String(formData.get("vehicle_id") ?? ""),
    String(formData.get("driver_id") ?? ""),
    ctx.userId,
  );
  revalidatePath("/ops/bookings");
}

/**
 * Delete an unassigned booking outright. Anything further along is cancelled instead —
 * see `deleteBooking` for why.
 */
export async function deleteBookingAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("bookings.write");
  await requireEntitlement("rental.core");
  await requireEntitlement("booking.b2b");
  await deleteBooking(
    ctx.tenantId,
    String(formData.get("booking_id") ?? ""),
    ctx.userId,
  );
  revalidatePath("/ops/bookings");
}

export async function transitionBookingAction(
  formData: FormData,
): Promise<void> {
  const ctx = await requirePermission("bookings.write");
  await requireEntitlement("rental.core");
  await requireEntitlement("booking.b2b");
  await transitionBooking(
    ctx.tenantId,
    String(formData.get("booking_id") ?? ""),
    String(formData.get("to") ?? "") as BookingStatus,
    ctx.userId,
  );
  revalidatePath("/ops/bookings");
}
