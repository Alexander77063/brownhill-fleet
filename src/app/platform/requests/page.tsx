import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Badge, Button, EmptyState } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import {
  approveSignupRequestAction,
  rejectSignupRequestAction,
} from "@/lib/actions/platform-console";

export const dynamic = "force-dynamic";

const SELECT =
  "id, company, contact_name, email, phone, fleet_size, message, status, created_at";

type SignupRequest = {
  id: string;
  company: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  fleet_size: number | string | null;
  message: string | null;
  status: string;
  created_at: string;
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <span className="text-parchment">{value}</span>
    </div>
  );
}

export default async function RequestsPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const sb = createServiceClient();
  const [pendingRes, reviewedRes] = await Promise.all([
    sb
      .from("tenant_signup_requests")
      .select(SELECT)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    sb
      .from("tenant_signup_requests")
      .select(SELECT)
      .neq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const pending = (pendingRes.data ?? []) as SignupRequest[];
  const reviewed = (reviewedRes.data ?? []) as SignupRequest[];

  const reviewedTone = (status: string) =>
    status === "approved" ? "profit" : status === "rejected" ? "loss" : "neutral";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Onboarding"
        title="Access requests"
        subtitle="Review inbound signups. Approving creates the tenant + owner account and (when email is configured) invites them."
      />

      <section className="space-y-4">
        {pending.length === 0 ? (
          <EmptyState
            title="No pending requests"
            hint="New signup requests will appear here for review."
          />
        ) : (
          pending.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <CardTitle>{r.company ?? "Unknown company"}</CardTitle>
                <p className="text-xs text-muted">Requested {fmtDate(r.created_at)}</p>
              </div>

              <div className="mt-3 space-y-1.5">
                <DetailRow label="Contact" value={r.contact_name} />
                <DetailRow label="Email" value={r.email} />
                <DetailRow label="Phone" value={r.phone} />
                <DetailRow label="Fleet size" value={r.fleet_size} />
                <DetailRow label="Message" value={r.message} />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <form action={approveSignupRequestAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <Button type="submit" variant="primary" size="sm">
                    Approve &amp; onboard
                  </Button>
                </form>
                <form action={rejectSignupRequestAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <Button type="submit" variant="outline" size="sm">
                    Reject
                  </Button>
                </form>
              </div>
            </Card>
          ))
        )}
      </section>

      {reviewed.length > 0 && (
        <section className="space-y-3">
          <p className="eyebrow">Recently reviewed</p>
          {reviewed.map((r) => (
            <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-cream">{r.company ?? "Unknown company"}</p>
                <p className="text-xs text-muted">
                  {r.contact_name ?? r.email ?? "—"} · {fmtDate(r.created_at)}
                </p>
              </div>
              <Badge tone={reviewedTone(r.status)}>{r.status}</Badge>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}
