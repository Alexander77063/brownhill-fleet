import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Button, Badge, Table, Th, Td, EmptyState } from "@/components/ui";
import { addUnitsAction, moveUnitAction, registerPendingUnitsAction, saveInstallerAction } from "@/lib/actions/hardware";
import { formatDate, relativeTime } from "@/lib/display";
import { JOB_KINDS, nextUnitState, UNIT_STATES, type UnitEvent, type UnitState } from "@/lib/hardware/derive";
import { listInstallers } from "@/lib/hardware/installers";
import { type JobRow, listJobs } from "@/lib/hardware/jobs";
import { KIND_NOUN } from "@/lib/hardware/notify";
import { hardwareReadiness } from "@/lib/hardware/readiness";
import { listUnits, stockSummary } from "@/lib/hardware/units";
import { formatMoney } from "@/lib/money";
import { regionProvider } from "@/lib/region";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const TABS = ["jobs", "inventory", "installers", "readiness"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { jobs: "Jobs", inventory: "Inventory", installers: "Installers", readiness: "Readiness" };
const MOVES: { event: UnitEvent; label: string }[] = [
  { event: "restock", label: "Back to stock" },
  { event: "fault", label: "Mark faulty" },
  { event: "return", label: "Returned to us" },
  { event: "retire", label: "Retire" },
  { event: "lose", label: "Lost" },
];

const inputCls = "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export default async function HardwarePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "jobs";
  const sb = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const region = regionProvider();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Platform"
        title="Hardware operations"
        subtitle="Jobs come from paid invoices. Stock is known by IMEI from the day it arrives. Installers are paid per job at the fee on their card."
      />
      <nav aria-label="Hardware sections" className="flex flex-wrap gap-2 border-b border-hair-soft pb-3 text-sm">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/platform/hardware?tab=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 transition ${t === tab ? "bg-[var(--surface)] text-cream" : "text-muted hover:text-cream"}`}
          >
            {TAB_LABEL[t]}
          </Link>
        ))}
      </nav>
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

      {tab === "jobs" && <JobsTab sb={sb} today={today} />}
      {tab === "inventory" && <InventoryTab sb={sb} state={sp.state} q={sp.q} regionMinorPerMajor={region.currency.minorPerMajor} />}
      {tab === "installers" && <InstallersTab sb={sb} minorPerMajor={region.currency.minorPerMajor} />}
      {tab === "readiness" && <ReadinessTab sb={sb} today={today} />}
    </div>
  );
}

type Sb = ReturnType<typeof createServiceClient>;

function statusTone(j: JobRow, today: string): "neutral" | "warn" | "loss" | "profit" | "gold" {
  if (j.status === "done") return "profit";
  if (j.status === "failed") return "loss";
  if (j.status === "cancelled") return "neutral";
  if (j.slaDueOn && j.slaDueOn < today) return "loss";
  if (j.status === "pending") return "warn";
  return "gold";
}

function JobsTable({ jobs, today, caption }: { jobs: JobRow[]; today: string; caption: string }) {
  if (!jobs.length) return <EmptyState title={`No ${caption.toLowerCase()}`} />;
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>Job</Th>
          <Th>Subscriber</Th>
          <Th>Status</Th>
          <Th>Source</Th>
          <Th>Installer</Th>
          <Th>Booked</Th>
          <Th>SLA</Th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <Td>
              <Link href={`/platform/hardware/jobs/${j.id}`} className="text-gold-bright hover:underline">
                {KIND_NOUN[j.kind]}
              </Link>{" "}
              <span className="text-cream">{j.vehicle?.registration ?? "—"}</span> <span className="text-muted">{j.vehicle?.make ?? ""}</span>
            </Td>
            <Td>
              <Link href={`/platform/subscribers/${j.tenantId}`} className="hover:underline">
                {j.tenantName}
              </Link>
            </Td>
            <Td>
              <Badge tone={statusTone(j, today)}>{j.status.replace("_", " ")}</Badge>
              {j.detail.awaiting_payment ? <span className="ml-1 text-xs text-muted">awaiting payment</span> : null}
            </Td>
            <Td>{j.source}</Td>
            <Td>{j.installer?.name ?? <span className="text-muted">—</span>}</Td>
            <Td>{j.scheduledAt ? relativeTime(j.scheduledAt) : <span className="text-muted">—</span>}</Td>
            <Td>
              {j.slaDueOn ? (
                <span className={j.slaDueOn < today && !["done", "cancelled"].includes(j.status) ? "text-[var(--color-loss)]" : ""}>{formatDate(j.slaDueOn)}</span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

async function JobsTab({ sb, today }: { sb: Sb; today: string }) {
  const [open, closed] = await Promise.all([listJobs({ scope: "open" }, sb), listJobs({ scope: "closed", limit: 50 }, sb)]);
  const overdue = open.filter((j) => j.slaDueOn && j.slaDueOn < today).length;
  return (
    <>
      <Card>
        <CardTitle>
          Open jobs <span className="text-muted">· {open.length}</span>
          {overdue > 0 && (
            <Badge tone="loss">
              {overdue} past SLA
            </Badge>
          )}
        </CardTitle>
        <JobsTable jobs={open} today={today} caption="Open jobs" />
      </Card>
      <Card>
        <CardTitle>Recently closed</CardTitle>
        <JobsTable jobs={closed} today={today} caption="Closed jobs" />
      </Card>
    </>
  );
}

async function InventoryTab({ sb, state, q, regionMinorPerMajor }: { sb: Sb; state?: string; q?: string; regionMinorPerMajor: number }) {
  const filter = (UNIT_STATES as readonly string[]).includes(state ?? "") ? (state as UnitState) : "all";
  const [summary, units] = await Promise.all([stockSummary(sb), listUnits({ state: filter, q, limit: 300 }, sb)]);
  return (
    <>
      <Card>
        <CardTitle>Stock</CardTitle>
        <div className="flex flex-wrap gap-2 text-sm">
          {UNIT_STATES.map((s) => (
            <Link key={s} href={`/platform/hardware?tab=inventory&state=${s}`} className={`rounded-md border border-hair px-2.5 py-1 ${filter === s ? "bg-[var(--surface)] text-cream" : "text-parchment hover:text-cream"}`}>
              {s.replace("_", " ")} <span className="tnum text-muted">{summary[s]}</span>
            </Link>
          ))}
          <Link href="/platform/hardware?tab=inventory" className={`rounded-md border border-hair px-2.5 py-1 ${filter === "all" ? "bg-[var(--surface)] text-cream" : "text-parchment hover:text-cream"}`}>
            all
          </Link>
          {summary.traccarPending > 0 && (
            <form action={registerPendingUnitsAction} className="ml-auto">
              <Button type="submit" size="sm" variant="outline">
                Register {summary.traccarPending} pending with the gateway
              </Button>
            </form>
          )}
        </div>
        <form method="get" className="mt-3 flex items-end gap-2">
          <input type="hidden" name="tab" value="inventory" />
          {filter !== "all" && <input type="hidden" name="state" value={filter} />}
          <label className="block text-xs text-parchment">
            <span className="mb-1 block font-semibold uppercase tracking-wider">Find</span>
            <input name="q" defaultValue={q ?? ""} placeholder="IMEI, ICCID, number, batch" className={`${inputCls} w-64`} />
          </label>
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>
        {units.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No units match" />
          </div>
        ) : (
          <div className="mt-3">
            <Table caption="Units">
              <thead>
                <tr>
                  <Th>IMEI</Th>
                  <Th>Model</Th>
                  <Th>State</Th>
                  <Th>Where</Th>
                  <Th>Gateway</Th>
                  <Th>Last seen</Th>
                  <Th>Move</Th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) => {
                  const allowed = MOVES.filter((m) => {
                    try {
                      nextUnitState(u.state, m.event);
                      return true;
                    } catch {
                      return false;
                    }
                  });
                  return (
                    <tr key={u.id}>
                      <Td>
                        <span className="tnum text-cream">{u.imei}</span>
                        {u.hasImmobiliser && (
                          <Badge tone="gold">
                            relay
                          </Badge>
                        )}
                      </Td>
                      <Td>
                        {u.model ?? "—"} <span className="text-muted">{u.vendor ?? ""}</span>
                        {u.batchRef && <span className="block text-xs text-muted">batch {u.batchRef}</span>}
                      </Td>
                      <Td>
                        <Badge tone={u.state === "in_stock" ? "profit" : u.state === "fitted" ? "gold" : u.state === "faulty" || u.state === "lost" ? "loss" : "neutral"}>{u.state.replace("_", " ")}</Badge>
                      </Td>
                      <Td>
                        {u.registration ? (
                          <span>
                            {u.registration} <span className="text-muted">{u.tenantName ?? ""}</span>
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      <Td>{u.traccarPending ? <Badge tone="warn">pending</Badge> : u.traccarDeviceId ? <span className="tnum text-muted">#{u.traccarDeviceId}</span> : <span className="text-muted">—</span>}</Td>
                      <Td>{u.lastSeenAt ? relativeTime(u.lastSeenAt) : <span className="text-muted">never</span>}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {allowed.map((m) => (
                            <form key={m.event} action={moveUnitAction}>
                              <input type="hidden" name="unit_id" value={u.id} />
                              <input type="hidden" name="event" value={m.event} />
                              <Button type="submit" size="sm" variant="ghost">
                                {m.label}
                              </Button>
                            </form>
                          ))}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Receive one unit</CardTitle>
          <form action={addUnitsAction} className="grid grid-cols-2 gap-3">
            <Field label="IMEI">
              <input name="imei" required inputMode="numeric" pattern="\d{14,17}" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Model">
              <input name="model" placeholder="GT06N" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Vendor">
              <input name="vendor" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Batch / PO">
              <input name="batch_ref" className={`${inputCls} w-full`} />
            </Field>
            <Field label="SIM ICCID">
              <input name="iccid" className={`${inputCls} w-full`} />
            </Field>
            <Field label="SIM number">
              <input name="msisdn" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Purchased on">
              <input name="purchased_on" type="date" className={`${inputCls} w-full`} />
            </Field>
            <Field label={`Unit cost (${regionProvider().currency.code}, major units)`} hint={`Stored ×${regionMinorPerMajor} in minor units.`}>
              <input name="unit_cost" type="number" min="0" step="any" className={`${inputCls} w-full`} />
            </Field>
            <label className="col-span-2 flex items-center gap-1.5 text-xs text-parchment">
              <input type="checkbox" name="has_immobiliser" /> Has an immobiliser relay (Platinum)
            </label>
            <Field label="Notes">
              <input name="notes" className={`${inputCls} w-full`} />
            </Field>
            <div className="col-span-2">
              <Button type="submit" size="sm" variant="primary">
                Add to stock
              </Button>
            </div>
          </form>
        </Card>
        <Card>
          <CardTitle>Receive a batch (CSV)</CardTitle>
          <form action={addUnitsAction} className="space-y-3">
            <Field label="Paste CSV" hint="Header row with any of: imei, iccid, msisdn, vendor, model, firmware, immobiliser (yes/no), batch, purchased_on, unit_cost_minor, notes. Only imei is required.">
              <textarea name="csv" rows={8} className={`${inputCls} w-full font-mono text-xs`} placeholder={"imei,model,immobiliser,batch\n860000000000001,GT06N,no,PO-1042"} />
            </Field>
            <Button type="submit" size="sm" variant="primary">
              Add batch
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}

async function InstallersTab({ sb, minorPerMajor }: { sb: Sb; minorPerMajor: number }) {
  const installers = await listInstallers({}, sb);
  const region = regionProvider();
  const major = (minor: number | undefined) => (minor == null ? "" : String(minor / minorPerMajor));
  return (
    <>
      <Card>
        <CardTitle>Installers</CardTitle>
        {installers.length === 0 ? (
          <EmptyState title="No installers yet" />
        ) : (
          <Table caption="Installers">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>City</Th>
                <Th>Phone</Th>
                {JOB_KINDS.map((k) => (
                  <Th key={k}>{k} fee</Th>
                ))}
                <Th>Active</Th>
              </tr>
            </thead>
            <tbody>
              {installers.map((i) => (
                <tr key={i.id}>
                  <Td>{i.name}</Td>
                  <Td>{i.kind}</Td>
                  <Td>{i.city ?? "—"}</Td>
                  <Td className="tnum">{i.phone}</Td>
                  {JOB_KINDS.map((k) => (
                    <Td key={k}>{i.fees[k] != null ? formatMoney(i.fees[k] as number, { region: region.id }) : <span className="text-muted">—</span>}</Td>
                  ))}
                  <Td>{i.active ? <Badge tone="profit">active</Badge> : <span className="text-muted">off</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {[...installers, null].map((i) => (
        <details key={i?.id ?? "new"} className="rounded-lg border border-hair" open={!i && installers.length === 0}>
          <summary className="cursor-pointer px-4 py-2 text-sm text-parchment">{i ? `Edit ${i.name}` : "New installer"}</summary>
          <form action={saveInstallerAction} className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
            {i && <input type="hidden" name="id" value={i.id} />}
            <Field label="Name">
              <input name="name" required defaultValue={i?.name ?? ""} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Phone (jobs are texted here)">
              <input name="phone" required defaultValue={i?.phone ?? ""} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Email">
              <input name="email" type="email" defaultValue={i?.email ?? ""} className={`${inputCls} w-full`} />
            </Field>
            <Field label="City">
              <input name="city" defaultValue={i?.city ?? ""} className={`${inputCls} w-full`} />
            </Field>
            <Field label="Kind">
              <select name="kind" defaultValue={i?.kind ?? "partner"} className={`${inputCls} w-full`}>
                <option value="partner">partner (paid per job)</option>
                <option value="own">our own team</option>
              </select>
            </Field>
            {JOB_KINDS.map((k) => (
              <Field key={k} label={`${k} fee (${region.currency.code})`}>
                <input name={`fee_${k}`} type="number" min="0" step="any" defaultValue={major(i?.fees[k])} className={`${inputCls} w-full`} />
              </Field>
            ))}
            <Field label="Notes">
              <input name="notes" defaultValue={i?.notes ?? ""} className={`${inputCls} w-full`} />
            </Field>
            <label className="flex items-center gap-1.5 self-end text-xs text-parchment">
              <input type="checkbox" name="active" defaultChecked={i?.active ?? true} /> Active
            </label>
            <div className="col-span-2 sm:col-span-4">
              <Button type="submit" size="sm" variant="primary">
                {i ? "Save" : "Add installer"}
              </Button>
            </div>
          </form>
        </details>
      ))}
    </>
  );
}

async function ReadinessTab({ sb, today }: { sb: Sb; today: string }) {
  const r = await hardwareReadiness(sb, process.env, today);
  if (!r.applies) return <EmptyState title="Hardware operations are not part of this build" />;
  return (
    <>
      <Card>
        <CardTitle>
          Readiness <Badge tone={r.ok ? "profit" : "loss"}>{r.ok ? "ready" : "blocked"}</Badge>
        </CardTitle>
        <ul className="space-y-1 text-sm">
          <li>
            Tracking gateway:{" "}
            {!r.traccar.configured ? <Badge tone="loss">not configured</Badge> : r.traccar.reachable ? <Badge tone="profit">reachable</Badge> : <Badge tone="loss">unreachable</Badge>}
          </li>
          <li>
            Active installers: <span className="tnum text-cream">{r.installers}</span>
          </li>
          <li>
            In stock: <span className="tnum text-cream">{r.stock.in_stock}</span>
            {r.byModel.length > 0 && <span className="text-muted"> ({r.byModel.map((m) => `${m.inStock} × ${m.model}`).join(", ")})</span>}
          </li>
        </ul>
        {r.blocking.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-[var(--color-loss)]">
            {r.blocking.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {r.warnings.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-parchment">
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardTitle>Past the fitting SLA</CardTitle>
        <JobsTable jobs={r.overdue} today={today} caption="Overdue jobs" />
      </Card>
      <Card>
        <CardTitle>Fitted but never reported</CardTitle>
        {r.silent.length === 0 ? (
          <EmptyState title="Every fitted unit has reported" />
        ) : (
          <Table caption="Silent fitted units">
            <thead>
              <tr>
                <Th>Vehicle</Th>
                <Th>Subscriber</Th>
                <Th>IMEI</Th>
                <Th>Fitted</Th>
              </tr>
            </thead>
            <tbody>
              {r.silent.map((d) => (
                <tr key={d.deviceId}>
                  <Td>{d.registration}</Td>
                  <Td>
                    <Link href={`/platform/subscribers/${d.tenantId}`} className="hover:underline">
                      {d.tenantName}
                    </Link>
                  </Td>
                  <Td className="tnum">{d.imei ?? "—"}</Td>
                  <Td>{relativeTime(d.fittedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
