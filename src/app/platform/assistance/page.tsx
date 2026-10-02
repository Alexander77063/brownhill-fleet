import { requirePlatformAdmin } from "@/lib/auth/context";
import Link from "next/link";
import { PageHeader, Card, Badge, Button, Table, Th, Td, EmptyState } from "@/components/ui";
import { listOpenRequests, REQUEST_LABEL, escalationConfigured } from "@/lib/requests";
import { isEmergencyKind } from "@/lib/escalation";
import { acknowledgeRequestAction, closeRequestAction } from "@/lib/actions/requests";
import { relativeTime } from "@/lib/display";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export default async function AssistancePage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const [requests, readiness] = await Promise.all([listOpenRequests(), escalationConfigured()]);
  const open = requests.filter((r) => r.status === "open");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Assistance"
        title="Requests from owners and insurers"
        subtitle={`${open.length} open · emergencies first. Acknowledging stops the calls; closing records what was done.`}
      />

      {readiness.broken && (
        <Card>
          <p className="text-sm text-[var(--color-loss)]">
            Escalation is not configured — emergencies are not reaching anyone.{" "}
            <Link href="/platform/oncall" className="underline">
              Set up the on-call roster
            </Link>
            .
          </p>
        </Card>
      )}

      {requests.length === 0 ? (
        <EmptyState title="Nothing open" hint="Requests raised from the owner portal or by insurer staff appear here." />
      ) : (
        <Card className="p-0">
          <Table caption="Open and acknowledged requests">
            <thead>
              <tr>
                <Th>Raised</Th>
                <Th>Kind</Th>
                <Th>Owner</Th>
                <Th>Vehicle</Th>
                <Th>Tenant</Th>
                <Th>Ladder</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const emergency = isEmergencyKind(r.kind);
                return (
                  <tr key={r.id} className={r.status === "open" && emergency ? "bg-[rgba(220,80,80,0.06)]" : undefined}>
                    <Td className="tnum">{relativeTime(r.createdAt)}</Td>
                    <Td>
                      <Badge tone={emergency ? "loss" : "neutral"}>{REQUEST_LABEL[r.kind]}</Badge>
                    </Td>
                    <Td>
                      {r.owner ? (
                        <>
                          <span className="text-cream">{r.owner.name}</span>
                          <br />
                          <a href={`tel:${r.owner.phone}`} className="text-xs text-gold-bright">
                            {r.owner.phone}
                          </a>
                        </>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>{r.vehicle ? `${r.vehicle.make} ${r.vehicle.registration}` : "—"}</Td>
                    <Td className="text-xs text-muted">{r.tenantName}</Td>
                    <Td className="text-xs text-muted">
                      {r.status === "acknowledged" ? "stopped" : emergency ? `round ${r.escalationRound}` : "—"}
                    </Td>
                    <Td className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Link href={`/platform/assistance/${r.id}`} className="text-xs text-gold-bright hover:underline">
                          Open
                        </Link>
                        {r.status === "open" && (
                          <form action={acknowledgeRequestAction}>
                            <input type="hidden" name="id" value={r.id} />
                            <Button type="submit" variant="primary" size="sm" aria-label={`Acknowledge request from ${r.owner?.name ?? "owner"}`}>
                              Acknowledge
                            </Button>
                          </form>
                        )}
                        {r.status === "acknowledged" && (
                          <form action={closeRequestAction} className="flex items-center gap-1">
                            <input type="hidden" name="id" value={r.id} />
                            <input name="resolution" required placeholder="What was done" aria-label="Resolution" className={inputCls} />
                            <Button type="submit" variant="outline" size="sm">
                              Close
                            </Button>
                          </form>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
