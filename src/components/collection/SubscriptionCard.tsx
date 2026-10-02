import { Badge } from "@/components/ui";
import { daysToAnniversary, statusLabel, type SubStatus } from "@/lib/collection/state";

const TONE: Record<SubStatus, "profit" | "info" | "loss" | "neutral" | "warn"> = {
  trialing: "info",
  unpaid: "warn",
  active: "profit",
  past_due: "loss",
  suspended: "loss",
  cancelled: "neutral",
};

/** The one-line truth about a subscription, the same on every surface. Pure props; no fetching. */
export function SubscriptionCard({
  status,
  anniversaryOn,
  planName,
  billedVehicles,
  today,
  children,
}: {
  status: SubStatus;
  anniversaryOn: string | null;
  planName: string | null;
  billedVehicles: number;
  today: string;
  children?: React.ReactNode;
}) {
  const days = daysToAnniversary({ anniversaryOn }, today);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <Badge tone={TONE[status] ?? "neutral"}>{statusLabel(status)}</Badge>
      <span className="text-parchment">
        Plan <strong className="text-cream">{planName ?? "none"}</strong>
      </span>
      <span className="text-parchment">
        Vehicles <strong className="text-cream tnum">{billedVehicles}</strong>
      </span>
      {anniversaryOn && (
        <span className="text-parchment">
          {status === "active" || status === "past_due" ? "Renews" : "Anniversary"} <strong className="text-cream">{anniversaryOn}</strong>
          {days !== null && (
            <span className="text-muted">
              {" "}
              ({days >= 0 ? `in ${days} day${days === 1 ? "" : "s"}` : `${-days} day${days === -1 ? "" : "s"} ago`})
            </span>
          )}
        </span>
      )}
      {children}
    </div>
  );
}
