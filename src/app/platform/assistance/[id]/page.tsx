import { requirePlatformAdmin } from "@/lib/auth/context";
import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, Card, CardTitle, Badge, Button } from "@/components/ui";
import { getRequest, REQUEST_LABEL } from "@/lib/requests";
import { isEmergencyKind } from "@/lib/escalation";
import { acknowledgeRequestAction, closeRequestAction } from "@/lib/actions/requests";
import { executeImmobiliseAction } from "@/lib/actions/hardware";
import { platformSettings } from "@/lib/collection/settings";
import { COMMANDABLE_REQUEST_KINDS, commandsForRequest } from "@/lib/hardware/commands";
import { gateReasonText, speedGate } from "@/lib/hardware/speed-gate";
import { getImmobilisationState, UNAVAILABLE_TEXT } from "@/lib/immobilise";
import { createServiceClient } from "@/lib/supabase/server";
import { formatDate, relativeTime } from "@/lib/display";

export const dynamic = "force-dynamic";

const inputCls =
  "w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export default async function AssistanceDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePlatformAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const r = await getRequest(id);
  if (!r) notFound();
  const sb = createServiceClient();
  const commandable = (COMMANDABLE_REQUEST_KINDS as readonly string[]).includes(r.kind) && Boolean(r.vehicle);
  const [{ data: log }, { data: audit }, immob, commands, settings, { data: pos }] = await Promise.all([
    sb.from("notifications").select("channel, recipient, status, error, created_at").eq("entity_type", "owner_request").eq("entity_id", id).order("created_at"),
    sb.from("audit_log").select("action, detail, created_at").eq("entity_id", id).order("created_at"),
    commandable && r.vehicle ? getImmobilisationState(r.tenantId, r.vehicle.id) : Promise.resolve(null),
    commandable ? commandsForRequest(id, sb) : Promise.resolve([]),
    platformSettings(sb),
    commandable && r.vehicle ? sb.from("vehicle_positions").select("speed_mph, recorded_at").eq("vehicle_id", r.vehicle.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const emergency = isEmergencyKind(r.kind);
  const gate = commandable ? speedGate(pos ? { speedMph: pos.speed_mph == null ? null : Number(pos.speed_mph), recordedAt: pos.recorded_at } : null, new Date(), settings, "immobilise") : null;
  const canExecute = commandable && r.status === "acknowledged" && Boolean(immob?.hardwareConnected);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Assistance"
        title={REQUEST_LABEL[r.kind]}
        subtitle={`${r.owner?.name ?? "Unknown owner"} · ${r.vehicle ? `${r.vehicle.make} ${r.vehicle.registration}` : "no vehicle"} · ${r.tenantName} · raised ${relativeTime(r.createdAt)} by ${r.raisedRole}`}
        actions={
          <Button href="/platform/assistance" variant="ghost" size="sm">
            All requests
          </Button>
        }
      />
      {sp.msg && (
        <p role="status" className="rounded-md border border-hair px-3 py-2 text-sm text-parchment">
          {sp.msg}
        </p>
      )}
      {sp.error && (
        <p role="alert" className="rounded-md border border-[var(--color-loss)] px-3 py-2 text-sm text-[var(--color-loss)]">
          {sp.error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Status</CardTitle>
          <p className="text-sm text-parchment">
            <Badge tone={r.status === "open" ? (emergency ? "loss" : "warn") : r.status === "acknowledged" ? "profit" : "neutral"}>{r.status}</Badge>{" "}
            {emergency && r.status === "open" && <span className="text-muted">escalation round {r.escalationRound} — calls continue until acknowledged</span>}
            {r.acknowledgedAt && <span className="text-muted">acknowledged {relativeTime(r.acknowledgedAt)}</span>}
          </p>
          {r.note && <p className="mt-3 text-sm text-cream">“{r.note}”</p>}
          {r.owner && (
            <p className="mt-3 text-sm">
              Call the owner:{" "}
              <a href={`tel:${r.owner.phone}`} className="text-gold-bright hover:underline">
                {r.owner.phone}
              </a>
            </p>
          )}
          {r.status === "open" && (
            <form action={acknowledgeRequestAction} className="mt-4">
              <input type="hidden" name="id" value={r.id} />
              <Button type="submit" variant="primary" size="sm">
                I have this — stop the calls
              </Button>
            </form>
          )}
          {r.status !== "closed" && (
            <form action={closeRequestAction} className="mt-4 space-y-2">
              <input type="hidden" name="id" value={r.id} />
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Resolution</span>
                <textarea name="resolution" required rows={3} className={inputCls} placeholder="What was done, and the outcome" />
              </label>
              <Button type="submit" variant="outline" size="sm">
                Close request
              </Button>
            </form>
          )}
        </Card>

        {commandable && r.vehicle && immob && gate && (
          <Card>
            <CardTitle>Engine control</CardTitle>
            <p className="text-sm text-muted">
              Only our on-call team sends an engine cut, against an acknowledged request, when the vehicle is stopped. Release is never gated. Every attempt is
              logged with who sent it and the speed at the time.
            </p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Hardware</dt>
              <dd>{immob.hardwareConnected ? <Badge tone="profit">relay fitted and registered</Badge> : <span className="text-[var(--color-loss)]">{immob.unavailableReason ? UNAVAILABLE_TEXT[immob.unavailableReason] : "unavailable"}</span>}</dd>
              <dt className="text-muted">Vehicle now</dt>
              <dd>
                {pos ? (
                  <span>
                    {pos.speed_mph == null ? "speed unknown" : `${Math.round(Number(pos.speed_mph) * 1.609344)} km/h`} · {relativeTime(pos.recorded_at)}
                  </span>
                ) : (
                  <span className="text-muted">no position</span>
                )}
              </dd>
              <dt className="text-muted">Engine cut</dt>
              <dd>{gate.ok ? <Badge tone="profit">allowed now</Badge> : <span className="text-parchment">{gateReasonText(gate.reason, settings)}</span>}</dd>
              <dt className="text-muted">Last command</dt>
              <dd>{immob.requested ? `${immob.requested} · ${immob.status}${immob.at ? ` · ${relativeTime(immob.at)}` : ""}` : "none"}</dd>
            </dl>
            {r.status === "closed" ? (
              <p className="mt-3 text-sm text-muted">The request is closed.</p>
            ) : r.status !== "acknowledged" ? (
              <p className="mt-3 text-sm text-parchment">Acknowledge the request and verify it with the owner before sending a command.</p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <form action={executeImmobiliseAction}>
                <input type="hidden" name="request_id" value={r.id} />
                <input type="hidden" name="action" value="immobilise" />
                <Button type="submit" variant="primary" size="sm" disabled={!canExecute || !gate.ok}>
                  Cut the engine
                </Button>
              </form>
              <form action={executeImmobiliseAction}>
                <input type="hidden" name="request_id" value={r.id} />
                <input type="hidden" name="action" value="release" />
                <Button type="submit" variant="outline" size="sm" disabled={!canExecute}>
                  Release
                </Button>
              </form>
              <Link href={`/platform/subscribers/${r.tenantId}`} className="self-center text-sm text-gold-bright hover:underline">
                Subscriber
              </Link>
            </div>
            {commands.length > 0 && (
              <ul className="mt-4 divide-y divide-hair text-sm">
                {commands.map((c) => (
                  <li key={c.id} className="py-1.5">
                    <span className="text-xs text-muted">
                      {formatDate(c.createdAt.slice(0, 10))} {c.createdAt.slice(11, 16)}
                    </span>{" "}
                    <span className="text-cream">{c.action}</span>{" "}
                    <Badge tone={c.status === "acknowledged" ? "profit" : c.status === "failed" ? "loss" : "gold"}>{c.status}</Badge>
                    {c.speedKphAtSend != null && <span className="ml-2 text-xs text-muted">{c.speedKphAtSend} km/h</span>}
                    {c.failureReason && <span className="ml-2 text-xs text-[var(--color-loss)]">{c.failureReason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card>
          <CardTitle>Escalation log</CardTitle>
          {(audit ?? []).length === 0 && (log ?? []).length === 0 ? (
            <p className="text-sm text-muted">Nothing yet — the ladder runs every five minutes.</p>
          ) : (
            <ul className="divide-y divide-hair text-sm">
              {(audit ?? []).map((a, i) => (
                <li key={`a${i}`} className="py-1.5">
                  <span className="text-xs text-muted">
                    {formatDate(a.created_at.slice(0, 10))} {a.created_at.slice(11, 16)}
                  </span>{" "}
                  <span className="text-cream">{a.action}</span> <span className="text-xs text-muted">{JSON.stringify(a.detail)}</span>
                </li>
              ))}
              {(log ?? []).map((n, i) => (
                <li key={`n${i}`} className="py-1.5">
                  <span className="text-xs text-muted">{n.created_at.slice(11, 16)}</span> {n.channel} → {n.recipient}{" "}
                  <Badge tone={n.status === "sent" ? "profit" : n.status === "skipped" ? "neutral" : "loss"}>{n.status}</Badge>
                  {n.error && <span className="ml-2 text-xs text-[var(--color-loss)]">{n.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
