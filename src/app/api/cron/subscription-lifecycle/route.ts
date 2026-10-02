import { type NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron";
import { syncAllBilledVehicles } from "@/lib/catalogue/quantity";
import { runCollectionLifecycle } from "@/lib/collection/lifecycle";
import { sendDueReminders, snapshotDailyMetrics } from "@/lib/platform/reminders";
import { payFirst } from "@/lib/region";

// Daily platform cron: reconcile every subscription's billed vehicle count; in a
// pay-first market (NG-2) run the collection lifecycle — renewals ahead of the
// anniversary, batched B2B additions, overdue marking, dunning, past_due →
// suspended → cancelled, gateway reconciliation; capture the daily MRR/churn
// snapshot; dispatch the UK SaaS's Stripe-shaped reminders. Every step is
// idempotent — the sync is a recount, invoices and reminders dedupe, the
// snapshot upserts on the day.
export const runtime = "nodejs";
// Sequential provider calls per invoice; give the job room before Vercel cuts it off.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await syncAllBilledVehicles();
  const collection = payFirst() ? await runCollectionLifecycle({ appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null }) : null;
  await snapshotDailyMetrics();
  const reminders = await sendDueReminders();
  return NextResponse.json({ ok: true, reminders, collection });
}
