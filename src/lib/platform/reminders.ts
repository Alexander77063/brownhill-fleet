/** Subscription reminders + daily metrics snapshot (platform cron).
 *
 *  `selectDueReminders` is a PURE decision function (unit-tested): given the
 *  current subscriptions, the tenants, their owner emails, what's already been
 *  sent, and today's date, it returns exactly which reminders are due. The async
 *  wrappers below load that state, dispatch via notify.ts, and record each send
 *  in `subscription_reminders` (the unique constraint enforces once-per-period).
 */
import { createServiceClient } from "@/lib/supabase/server";
import { daysBetween, todayISO } from "@/lib/cron";
import { sendEmail } from "@/lib/notify";
import {
  OPERATOR_TENANT_ID,
  computeMrr,
  planMrrPence,
  type AddonLite,
  type PlanLite,
  type SubLite,
  type TenantAddonLite,
} from "@/lib/platform/metrics";

export type ReminderKind = "renewal_upcoming" | "trial_ending" | "past_due";

export interface DueReminder {
  tenantId: string;
  name: string;
  kind: ReminderKind;
  periodEnd: string | null;
  ownerEmail: string | null;
}

const dedupeKey = (tenantId: string, kind: ReminderKind, periodEnd: string | null) =>
  `${tenantId}:${kind}:${periodEnd ?? ""}`;

const dayPart = (ts: string | null): string | null => (ts ? ts.slice(0, 10) : null);

/** PURE. Decide which reminders are due today.
 *  - trial_ending:   status 'trialing' & period end within 0..3 days
 *  - renewal_upcoming: status 'active' & period end within 0..7 days
 *  - past_due:       status 'past_due' (fires regardless of date)
 *  Null period_end skips the date-based kinds (never crashes). Anything already
 *  in `alreadySent` (keyed tenant:kind:periodEnd) is suppressed. */
export function selectDueReminders(input: {
  subs: { tenant_id: string; status: string; current_period_end: string | null }[];
  tenants: { id: string; name: string }[];
  owners: Record<string, string | null>;
  alreadySent: Set<string>;
  today: string;
}): DueReminder[] {
  const nameOf = new Map(input.tenants.map((t) => [t.id, t.name]));
  const due: DueReminder[] = [];

  for (const sub of input.subs) {
    if (sub.tenant_id === OPERATOR_TENANT_ID) continue;
    const end = dayPart(sub.current_period_end);
    const daysToEnd = end ? daysBetween(input.today, end) : null;

    let kind: ReminderKind | null = null;
    if (sub.status === "past_due") {
      kind = "past_due";
    } else if (sub.status === "trialing" && daysToEnd !== null && daysToEnd >= 0 && daysToEnd <= 3) {
      kind = "trial_ending";
    } else if (sub.status === "active" && daysToEnd !== null && daysToEnd >= 0 && daysToEnd <= 7) {
      kind = "renewal_upcoming";
    }
    if (!kind) continue;

    const periodEnd = sub.current_period_end;
    if (input.alreadySent.has(dedupeKey(sub.tenant_id, kind, periodEnd))) continue;

    due.push({
      tenantId: sub.tenant_id,
      name: nameOf.get(sub.tenant_id) ?? sub.tenant_id,
      kind,
      periodEnd,
      ownerEmail: input.owners[sub.tenant_id] ?? null,
    });
  }
  return due;
}

const SUBJECTS: Record<ReminderKind, string> = {
  renewal_upcoming: "Your Elite Fleet Management subscription renews soon",
  trial_ending: "Your Elite Fleet Management trial is ending",
  past_due: "Action needed: your Elite Fleet Management payment is past due",
};

function reminderBody(r: DueReminder): string {
  const when = r.periodEnd ? new Date(r.periodEnd).toUTCString().slice(0, 16) : "soon";
  const lines: Record<ReminderKind, string> = {
    renewal_upcoming: `<p>Hi ${r.name},</p><p>Your subscription renews on <strong>${when}</strong>. No action is needed — this is a friendly heads-up.</p>`,
    trial_ending: `<p>Hi ${r.name},</p><p>Your free trial ends on <strong>${when}</strong>. Add a plan to keep your fleet running without interruption.</p>`,
    past_due: `<p>Hi ${r.name},</p><p>We couldn't process your latest payment. Please update your billing details to avoid any interruption to your service.</p>`,
  };
  return `${lines[r.kind]}<p>— The Elite Fleet Management team</p>`;
}

/** Load state, send every due reminder to the tenant owner, and record it. */
export async function sendDueReminders(
  sb = createServiceClient(),
  today: string = todayISO(),
): Promise<{ sent: number; skipped: number; due: number }> {
  const [subsRes, tenantsRes, sentRes] = await Promise.all([
    sb.from("tenant_subscription").select("tenant_id, status, current_period_end"),
    sb.from("tenants").select("id, name"),
    sb.from("subscription_reminders").select("tenant_id, kind, period_end"),
  ]);

  const subs = subsRes.data ?? [];
  const tenants = tenantsRes.data ?? [];
  const alreadySent = new Set(
    (sentRes.data ?? []).map((r) => dedupeKey(r.tenant_id, r.kind as ReminderKind, r.period_end)),
  );

  // Owner emails: the 'owner' membership per tenant → profile email.
  const owners: Record<string, string | null> = {};
  const memberRes = await sb
    .from("tenant_memberships")
    .select("tenant_id, user_id, profiles(email)")
    .eq("role", "owner")
    .eq("status", "active");
  for (const m of memberRes.data ?? []) {
    const email = (m as { profiles?: { email?: string | null } | null }).profiles?.email ?? null;
    if (!(m.tenant_id in owners)) owners[m.tenant_id] = email;
  }

  const due = selectDueReminders({ subs, tenants, owners, alreadySent, today });

  let sent = 0;
  let skipped = 0;
  for (const r of due) {
    let channel = "email";
    let status = "sent";
    let detail: string | null = null;

    if (r.ownerEmail) {
      const res = await sendEmail(r.ownerEmail, SUBJECTS[r.kind], reminderBody(r));
      if (res.sent) {
        sent += 1;
      } else {
        skipped += 1;
        status = res.skipped ? "skipped" : "failed";
        detail = res.error ?? (res.skipped ? "email transport not configured" : null);
      }
    } else {
      skipped += 1;
      status = "skipped";
      detail = "no owner email on file";
      channel = "none";
    }

    // Record even skips so we don't retry a no-op every run for the same period.
    await sb.from("subscription_reminders").insert({
      tenant_id: r.tenantId,
      kind: r.kind,
      period_end: r.periodEnd,
      channel,
      recipient: r.ownerEmail,
      status,
      detail,
    });
  }

  return { sent, skipped, due: due.length };
}

/** Send a single reminder on demand (operator-triggered), bypassing the due-date
 *  rules. Upserts the dedupe row so a manual resend for the same period overwrites
 *  rather than violating the unique constraint. */
export async function sendReminderNow(
  tenantId: string,
  kind: ReminderKind,
  sb = createServiceClient(),
): Promise<{ sent: boolean; status: string }> {
  const [tenantRes, subRes, ownerRes] = await Promise.all([
    sb.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
    sb.from("tenant_subscription").select("current_period_end").eq("tenant_id", tenantId).maybeSingle(),
    sb
      .from("tenant_memberships")
      .select("profiles(email)")
      .eq("tenant_id", tenantId)
      .eq("role", "owner")
      .eq("status", "active")
      .limit(1)
      .maybeSingle(),
  ]);

  const name = tenantRes.data?.name ?? tenantId;
  const periodEnd = subRes.data?.current_period_end ?? null;
  const ownerEmail = (ownerRes.data as { profiles?: { email?: string | null } | null } | null)?.profiles?.email ?? null;
  const r: DueReminder = { tenantId, name, kind, periodEnd, ownerEmail };

  let status = "sent";
  let sent = false;
  let detail: string | null = null;
  let channel = "email";

  if (ownerEmail) {
    const res = await sendEmail(ownerEmail, SUBJECTS[kind], reminderBody(r));
    sent = res.sent;
    if (!res.sent) {
      status = res.skipped ? "skipped" : "failed";
      detail = res.error ?? (res.skipped ? "email transport not configured" : null);
    }
  } else {
    status = "skipped";
    detail = "no owner email on file";
    channel = "none";
  }

  // Idempotent replace: an ON CONFLICT upsert can't match when period_end is NULL
  // (Postgres treats NULLs as distinct in a UNIQUE index), so a manual resend for
  // a null-period reminder would insert duplicates. Delete any existing row for
  // this (tenant, kind, period) first, then insert fresh — refreshing sent_at too.
  const del = sb.from("subscription_reminders").delete().eq("tenant_id", tenantId).eq("kind", kind);
  await (periodEnd === null ? del.is("period_end", null) : del.eq("period_end", periodEnd));
  await sb
    .from("subscription_reminders")
    .insert({ tenant_id: tenantId, kind, period_end: periodEnd, channel, recipient: ownerEmail, status, detail });

  return { sent, status };
}

/** Compute today's platform aggregate and upsert the daily snapshot row. */
export async function snapshotDailyMetrics(
  sb = createServiceClient(),
  day: string = todayISO(),
): Promise<void> {
  const [tenantsRes, subsRes, plansRes, addonsRes, taRes] = await Promise.all([
    sb.from("tenants").select("id, status"),
    sb.from("tenant_subscription").select("tenant_id, plan_id, status, current_period_end, billed_vehicles"),
    sb.from("plans").select("id, key, name, base_price_pence, interval, per_vehicle"),
    sb.from("addons").select("id, key, name, pricing_model, unit_price_pence"),
    sb.from("tenant_addons").select("tenant_id, addon_id, quantity, status"),
  ]);

  const tenants = (tenantsRes.data ?? []).filter((t) => t.id !== OPERATOR_TENANT_ID);
  const subs = (subsRes.data ?? []) as SubLite[];
  const plans = (plansRes.data ?? []) as PlanLite[];
  const addons = (addonsRes.data ?? []) as AddonLite[];
  const tenantAddons = (taRes.data ?? []) as TenantAddonLite[];

  const statusByTenant = new Map(
    subs.filter((s) => s.tenant_id !== OPERATOR_TENANT_ID).map((s) => [s.tenant_id, s.status]),
  );
  const count = (pred: (status: string | undefined, tenantStatus: string) => boolean) =>
    tenants.filter((t) => pred(statusByTenant.get(t.id), t.status)).length;

  const mrr = computeMrr({ subs, plans, addons, tenantAddons });

  const row = {
    day,
    tenants_total: tenants.length,
    tenants_active: count((_s, ts) => ts === "active"),
    tenants_trialing: count((s) => s === "trialing"),
    tenants_past_due: count((s) => s === "past_due"),
    tenants_cancelled: count((_s, ts) => ts === "cancelled"),
    paying_tenants: [...new Set(subs.filter((s) => planMrrPence(s, plans) > 0 && s.tenant_id !== OPERATOR_TENANT_ID).map((s) => s.tenant_id))].length,
    mrr_pence: mrr,
    arr_pence: mrr * 12,
  };

  await sb.from("platform_metrics_daily").upsert(row, { onConflict: "day" });
}
