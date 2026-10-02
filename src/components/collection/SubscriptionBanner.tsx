import Link from "next/link";
import type { SubStatus } from "@/lib/collection/state";

/** One line at the top of the owner portal whenever protection is not active. */
export function SubscriptionBanner({ status, anniversaryOn }: { status: SubStatus; anniversaryOn: string | null }) {
  if (status === "active" || status === "trialing") return null;
  const copy: Record<Exclude<SubStatus, "active" | "trialing">, { text: string; cta: string }> = {
    unpaid: { text: "Your vehicles are not protected yet. Choose a plan and pay to switch on tracking, alerts and reports.", cta: "Choose a plan" },
    past_due: { text: `Your renewal was due on ${anniversaryOn ?? "the anniversary"}. Protection continues for now — pay to keep it.`, cta: "Pay now" },
    suspended: { text: "Protection is paused for non-payment. Emergencies still reach us. Pay to resume alerts and reports.", cta: "Pay now" },
    cancelled: { text: "Your subscription was cancelled for non-payment. Start again any time.", cta: "Start again" },
  };
  const c = copy[status];
  const tone = status === "unpaid" ? "border-amber-500/60" : "border-[var(--color-loss)]";
  return (
    <p role="status" className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border ${tone} px-3 py-2 text-sm text-parchment`}>
      <span>{c.text}</span>
      <Link href="/owner/billing" className="font-semibold text-gold-bright underline-offset-2 hover:underline">
        {c.cta} →
      </Link>
    </p>
  );
}
