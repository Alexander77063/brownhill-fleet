"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import { inviteDriver } from "@/lib/ops/driver-invite";

export interface InviteDriverResult {
  ok: boolean;
  /** Set when ok=true; the URL ops should share with the driver to log in. */
  loginUrl?: string;
  /** Set when ok=true; the driver's email that was provisioned. */
  email?: string;
  /** Set when ok=false; a typed error code the panel can render. */
  error?: "missing_email" | "create_failed" | "duplicate";
  /** Human-readable error text, for the panel. */
  message?: string;
}

/** Invite a driver: create/link their login + tenant membership.
 *  Gated on drivers.write (ops role has it); tenantId comes from the server
 *  context, never the form.
 *
 *  Returns a structured result so the panel can show the operator the
 *  login URL the driver should use (we're on standalone — no email infra
 *  to actually send the link, so the operator copies it across manually). */
export async function inviteDriverAction(
  formData: FormData,
): Promise<InviteDriverResult> {
  const ctx = await requirePermission("drivers.write");
  const driverId = String(formData.get("driver_id") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  if (!email) {
    return { ok: false, error: "missing_email", message: "Login email is required so the driver can sign in." };
  }

  try {
    await inviteDriver({
      tenantId: ctx.tenantId,
      email,
      driverId: driverId || undefined,
      newDriver: driverId ? undefined : { full_name: fullName, phone: phone || undefined },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not invite driver.";
    return { ok: false, error: "create_failed", message: msg };
  }

  revalidatePath("/ops/drivers");

  // Build the URL the operator should share with the driver. The driver
  // portal has its own signin page (see /driver/login) so the driver
  // doesn't see the operator signin form by accident. Forwarded headers
  // when behind nginx (see auth/signout/route.ts for the same pattern).
  const hdrs = await headers();
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost";
  const base = `${proto}://${host}`;
  const loginUrl = `${base}/driver/login`;

  return { ok: true, email, loginUrl };
}
