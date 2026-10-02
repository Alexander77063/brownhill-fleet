"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import { requireEntitlement } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { createSigningSession } from "@/lib/signing";

/** Starts an online signing flow for an agreement, then shares the partner link.
 * Enforces the fine-grained `agreements.send` permission at this callable
 * boundary (on top of RLS). */
export async function sendForSignature(formData: FormData): Promise<void> {
  const ctx = await requirePermission("agreements.send");
  await requireEntitlement("contracts");
  const agreementId = String(formData.get("agreement_id") ?? "");
  if (!agreementId) throw new Error("Missing agreement");
  await createSigningSession(agreementId, ctx.tenantId, ctx.userId);
  revalidatePath(`/ops/agreements/${agreementId}`);
}

export interface SigningRow {
  id: string;
  reference: string;
  status: string;
  partner_link: string;
  partner_name: string | null;
  driver_name: string | null;
  driver_signed_at: string | null;
  created_at: string;
}

/** List an agreement's signing sessions with the partner link for ops to send.
 * Ops-only via RLS; partner_token is visible to ops (they need it to send). */
export async function listSigningSessions(
  agreementId: string,
): Promise<SigningRow[]> {
  const sb = await createClient();
  const { data } = await sb
    .from("signing_sessions")
    .select(
      "id, reference, status, partner_token, partner_name, driver_name, driver_signed_at, created_at",
    )
    .eq("agreement_id", agreementId)
    .order("created_at", { ascending: false });

  const origin = await baseUrl();
  return (data ?? []).map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    partner_link: `${origin}/sign/${r.partner_token}`,
    partner_name: r.partner_name,
    driver_name: r.driver_name,
    driver_signed_at: r.driver_signed_at,
    created_at: r.created_at,
  }));
}

async function baseUrl(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL)
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}
