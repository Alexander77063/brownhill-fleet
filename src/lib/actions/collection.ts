"use server";

/**
 * Platform-console actions for subscription collection (NG-2). Every action
 * begins with requirePlatformAdmin(); money moves only through
 * confirmPayment; amounts typed by an admin are major units and are converted
 * with the region pack's minorPerMajor, never a literal.
 */
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/context";
import {
  buildInitialDraft,
  buildOneOffDraft,
  confirmPayment,
  invoiceById,
  issueInvoice,
  recordEvent,
  todayISO,
  unpaidInvoices,
  voidInvoice,
} from "@/lib/collection/invoices";
import { notifyInvoiceIssued } from "@/lib/collection/notify-invoice";
import { addDaysISO } from "@/lib/collection/pricing";
import { platformSettings, saveSetting } from "@/lib/collection/settings";
import type { Settings, SettingsKey } from "@/lib/collection/settings-defaults";
import type { SubStatus } from "@/lib/collection/state";
import { regionProvider } from "@/lib/region";
import { createServiceClient } from "@/lib/supabase/server";

const SETTINGS = "/platform/settings";
const COLLECTIONS = "/platform/collections";
const SUBSCRIBERS = "/platform/subscribers";

function revalidate(tenantId?: string, invoiceId?: string): void {
  revalidatePath(COLLECTIONS);
  revalidatePath(SUBSCRIBERS);
  if (tenantId) revalidatePath(`${SUBSCRIBERS}/${tenantId}`);
  if (invoiceId) revalidatePath(`${COLLECTIONS}/${invoiceId}`);
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** An admin types major units ("129000" naira); the store is minor units. */
const minorFromMajor = (v: string) => Math.round(Number(v || 0) * regionProvider().currency.minorPerMajor);
const intList = (v: string) => v.split(/[,\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 0);

// ── Settings ─────────────────────────────────────────────────────────────────

export async function saveSettingAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const key = str(formData, "key") as SettingsKey;
  let value: Settings[SettingsKey];
  switch (key) {
    case "invoice.issuer":
      value = { legalName: str(formData, "legalName"), address: str(formData, "address"), tin: str(formData, "tin"), vatNumber: str(formData, "vatNumber"), email: str(formData, "email"), phone: str(formData, "phone") };
      break;
    case "invoice.bank":
      value = { bankName: str(formData, "bankName"), accountName: str(formData, "accountName"), accountNumber: str(formData, "accountNumber") };
      break;
    case "collection.reminder_days_before":
    case "collection.reminder_days_after":
      value = intList(str(formData, "value"));
      break;
    case "collection.preferred_gateway": {
      const v = str(formData, "value");
      value = v === "paystack" || v === "flutterwave" ? v : null;
      break;
    }
    case "collection.due_days_business":
    case "collection.renewal_issue_days":
    case "collection.grace_days":
    case "collection.cancel_days":
    case "collection.additions_batch_day":
    case "hardware.warranty_months":
    case "hardware.install_sla_days":
    case "hardware.immobilise_max_speed_kph":
    case "hardware.position_max_age_minutes":
    case "hardware.first_ping_hours":
      value = Number(str(formData, "value"));
      break;
    case "hardware.checklist":
      value = str(formData, "value")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      break;
    default:
      throw new Error("Unknown setting.");
  }
  await saveSetting(key, value as never, userId);
  revalidatePath(SETTINGS);
}

// ── Subscriber billing ───────────────────────────────────────────────────────

export async function saveBillingContactAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  if (!tenantId) throw new Error("A tenant is required.");
  const sb = createServiceClient();
  const { error } = await sb
    .from("tenant_subscription")
    .update({
      billing_name: str(formData, "billing_name") || null,
      billing_email: str(formData, "billing_email") || null,
      billing_phone: str(formData, "billing_phone") || null,
      billing_address: str(formData, "billing_address") || null,
      customer_tin: str(formData, "customer_tin") || null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  revalidate(tenantId);
}

/** First invoice for a fleet or insurer: the whole term for every billed vehicle plus the tier's hardware. */
export async function issueInitialInvoiceAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  if (!tenantId) throw new Error("A tenant is required.");
  const sb = createServiceClient();
  const [{ data: sub }, settings] = await Promise.all([
    sb.from("tenant_subscription").select("plan_id, status").eq("tenant_id", tenantId).maybeSingle(),
    platformSettings(sb),
  ]);
  if (!sub?.plan_id) throw new Error("Put the tenant on a plan first.");
  const open = await unpaidInvoices(tenantId, sb);
  if (open.some((i) => i.kind === "initial")) throw new Error("An initial invoice is already outstanding — void it first to re-issue.");
  const today = todayISO();
  const d = await buildInitialDraft(tenantId, sub.plan_id, sb, today);
  if (!d.lines.length) throw new Error("No billable vehicles — add the fleet before invoicing.");
  const issued = await issueInvoice({
    tenantId,
    kind: "initial",
    planId: sub.plan_id,
    lines: d.lines,
    period: d.period,
    dueOn: addDaysISO(today, settings["collection.due_days_business"]),
    currency: d.currency,
    vatRate: d.vatRate,
    actor: userId,
    sb,
    today,
  });
  const row = await invoiceById(tenantId, issued.id, sb);
  if (row) await notifyInvoiceIssued(row, { sb }).catch((e) => console.error("[collection] notify failed", e));
  revalidate(tenantId, issued.id);
}

/** An ad-hoc one-off invoice: a replacement device, an extra installation. Fields qty_<addonId>. */
export async function issueOneOffInvoiceAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  if (!tenantId) throw new Error("A tenant is required.");
  const vehicleId = str(formData, "vehicle_id") || undefined;
  const picks: { addonId: string; quantity: number; vehicleId?: string }[] = [];
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("qty_")) continue;
    const quantity = Number(v);
    if (Number.isInteger(quantity) && quantity > 0) picks.push({ addonId: k.slice(4), quantity, vehicleId });
  }
  if (!picks.length) throw new Error("Pick at least one item.");
  const sb = createServiceClient();
  const settings = await platformSettings(sb);
  const today = todayISO();
  const d = await buildOneOffDraft(picks, tenantId, sb);
  const issued = await issueInvoice({
    tenantId,
    kind: "one_off",
    lines: d.lines,
    dueOn: addDaysISO(today, settings["collection.due_days_business"]),
    currency: d.currency,
    vatRate: d.vatRate,
    actor: userId,
    note: str(formData, "note") || null,
    sb,
    today,
  });
  const row = await invoiceById(tenantId, issued.id, sb);
  if (row) await notifyInvoiceIssued(row, { sb }).catch((e) => console.error("[collection] notify failed", e));
  revalidate(tenantId, issued.id);
}

/** A bank transfer arrived: record it (with any withholding tax deducted) against the invoice. */
export async function recordTransferAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  const invoiceId = str(formData, "invoice_id");
  const reference = str(formData, "reference");
  if (!tenantId || !invoiceId) throw new Error("An invoice is required.");
  if (!reference) throw new Error("Enter the transfer reference or narration.");
  const sb = createServiceClient();
  const inv = await invoiceById(tenantId, invoiceId, sb);
  if (!inv) throw new Error("Invoice not found.");
  await confirmPayment({
    source: "bank_transfer",
    reference,
    invoiceId,
    amountMinor: minorFromMajor(str(formData, "amount")),
    whtMinor: minorFromMajor(str(formData, "wht")),
    currency: inv.currency,
    receivedOn: str(formData, "received_on") || undefined,
    note: str(formData, "note") || null,
    verifiedBy: userId,
    actor: userId,
    sb,
  });
  revalidate(tenantId, invoiceId);
}

export async function voidInvoiceAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  const invoiceId = str(formData, "invoice_id");
  const reason = str(formData, "reason");
  if (!tenantId || !invoiceId) throw new Error("An invoice is required.");
  if (!reason) throw new Error("Give a reason for voiding.");
  await voidInvoice(tenantId, invoiceId, reason, userId);
  revalidate(tenantId, invoiceId);
}

export async function resendInvoiceAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  const invoiceId = str(formData, "invoice_id");
  const sb = createServiceClient();
  const inv = await invoiceById(tenantId, invoiceId, sb);
  if (!inv) throw new Error("Invoice not found.");
  await notifyInvoiceIssued(inv, { sb, reason: "resent" });
  revalidate(tenantId, invoiceId);
}

/** Manual suspend / reactivate / cancel. Audit-logged as an event; payment still reactivates on its own. */
export async function setSubscriptionStateAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  const state = str(formData, "state");
  const map: Record<string, SubStatus> = { suspend: "suspended", reactivate: "active", cancel: "cancelled" };
  const to = map[state];
  if (!tenantId || !to) throw new Error("Invalid state change.");
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: to, updated_at: now };
  if (to === "suspended") patch.suspended_at = now;
  if (to === "cancelled") patch.cancelled_at = now;
  if (to === "active") Object.assign(patch, { past_due_since: null, suspended_at: null, cancelled_at: null });
  const sb = createServiceClient();
  const { error } = await sb.from("tenant_subscription").update(patch as never).eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  await recordEvent(sb, tenantId, null, `manual_${state}`, userId, { to });
  revalidate(tenantId);
}
