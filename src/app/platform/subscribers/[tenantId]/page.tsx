import { requirePlatformAdmin } from "@/lib/auth/context";
import {
  PageHeader,
  Card,
  CardTitle,
  Stat,
  Money,
  Badge,
  Button,
  Table,
  Th,
  Td,
  EmptyState,
} from "@/components/ui";
import { notFound } from "next/navigation";
import { getSubscriber } from "@/lib/platform/analytics";
import { listCatalogue } from "@/lib/catalogue/manage";
import { deploymentProfile, planAudience } from "@/lib/deployment/profile";
import {
  setSubscriptionStatusAction,
  setRenewalDateAction,
  setTenantLifecycleAction,
  sendReminderNowAction,
} from "@/lib/actions/platform-console";
import {
  setTenantPlanAction,
  toggleTenantAddonAction,
} from "@/lib/actions/platform";
import Link from "next/link";
import { SubscriptionCard } from "@/components/collection/SubscriptionCard";
import { createManualJobAction } from "@/lib/actions/hardware";
import { listJobs } from "@/lib/hardware/jobs";
import { KIND_NOUN } from "@/lib/hardware/notify";
import {
  issueInitialInvoiceAction,
  issueOneOffInvoiceAction,
  saveBillingContactAction,
  setSubscriptionStateAction,
} from "@/lib/actions/collection";
import { eventsForTenant, listInvoices, listOneOffItems, todayISO, UNPAID_STATUSES } from "@/lib/collection/invoices";
import { isUnpricedItem } from "@/lib/collection/pricing";
import type { SubStatus } from "@/lib/collection/state";
import { formatMoney } from "@/lib/money";
import { payFirst } from "@/lib/region";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

const HEALTH_TONE = {
  healthy: "profit",
  watch: "warn",
  at_risk: "loss",
} as const;

const STATUS_TONE: Record<
  string,
  "profit" | "info" | "loss" | "neutral"
> = {
  active: "profit",
  trialing: "info",
  unpaid: "info",
  past_due: "loss",
  suspended: "loss",
  cancelled: "neutral",
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  await requirePlatformAdmin();
  const { tenantId } = await params;
  const sub = await getSubscriber(tenantId);
  if (!sub) notFound();

  // Only this market's plans for this instance's audience in the picker; the
  // global catalogue console lists all.
  const { plans, addons } = await listCatalogue(undefined, {
    region: deploymentProfile().region,
    audience: planAudience(),
  });

  const healthTone = HEALTH_TONE[sub.health.band];

  // NG-2: in a pay-first market the money side replaces the Stripe card.
  const pay = payFirst();
  const today = todayISO();
  const region = deploymentProfile().region;
  const [invoices, items, events, subRow] = pay
    ? await Promise.all([
        listInvoices(sub.id),
        listOneOffItems(),
        eventsForTenant(sub.id, undefined, 25),
        createServiceClient()
          .from("tenant_subscription")
          .select("status, anniversary_on, billed_vehicles, billing_name, billing_email, billing_phone, billing_address, customer_tin")
          .eq("tenant_id", sub.id)
          .maybeSingle()
          .then((r) => r.data),
      ])
    : [[], [], [], null];
  const openInitial = invoices.some((i) => i.kind === "initial" && UNPAID_STATUSES.includes(i.status));
  const subStatus = ((subRow?.status as SubStatus | undefined) ?? "unpaid") as SubStatus;

  // NG-3: hardware on the managed product — what is fitted, what is pending.
  const hardwareBuild = deploymentProfile().ownerPortal;
  const [openJobs, fleet, fitted] = hardwareBuild
    ? await Promise.all([
        listJobs({ tenantId: sub.id, scope: "open" }),
        createServiceClient().from("vehicles").select("id, registration, make").eq("tenant_id", sub.id).order("registration").then((r) => r.data ?? []),
        createServiceClient()
          .from("telematics_devices")
          .select("vehicle_id, kind, state, fitted_at, first_ping_at, warranty_until, device_units(imei, model, has_immobiliser)")
          .eq("tenant_id", sub.id)
          .is("removed_at", null)
          .then((r) => (r.data ?? []) as unknown as Array<{ vehicle_id: string; kind: string; state: string; fitted_at: string | null; first_ping_at: string | null; warranty_until: string | null; device_units: { imei: string; model: string | null; has_immobiliser: boolean } | { imei: string; model: string | null; has_immobiliser: boolean }[] | null }>),
      ])
    : [[], [], []];
  const deviceByVehicle = new Map(fitted.map((d) => [d.vehicle_id, { ...d, unit: Array.isArray(d.device_units) ? (d.device_units[0] ?? null) : d.device_units }]));
  const jobByVehicle = new Map(openJobs.filter((j) => j.vehicleId).map((j) => [j.vehicleId as string, j]));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={sub.slug}
        title={sub.name}
        subtitle={undefined}
        actions={
          <Button href="/platform/subscribers" variant="ghost" size="sm">
            ← All subscribers
          </Button>
        }
      />

      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[sub.status] ?? "neutral"}>{sub.status}</Badge>
        <Badge tone={healthTone}>
          {sub.health.band.replace("_", " ")} · {sub.health.score}
        </Badge>
        {sub.isOperator && <Badge tone="gold">Operator</Badge>}
        {sub.planDrift && (
          <Badge tone="warn">
            legacy plan &ldquo;{sub.legacyPlan}&rdquo; ≠ subscription
          </Badge>
        )}
      </div>

      {/* ── Stat row ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="MRR" value={<Money pence={sub.mrrPence} />} tone="gold" />
        <Stat label="Plan" value={sub.planName} />
        <Stat label="Vehicles" value={<span className="tnum">{sub.usage.vehicles}</span>} />
        <Stat label="Drivers" value={<span className="tnum">{sub.usage.drivers}</span>} />
        <Stat label="Bookings" value={<span className="tnum">{sub.usage.bookings}</span>} />
        <Stat
          label="Renewal"
          value={
            <span className="text-lg">
              {sub.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : "—"}
            </span>
          }
        />
      </div>

      {/* ── Subscription ─────────────────────────────────────────── */}
      <Card>
        <CardTitle>Subscription</CardTitle>
        <div className="mt-4 flex flex-wrap items-end gap-6">
          <form
            action={setSubscriptionStatusAction}
            className="flex items-center gap-2"
          >
            <input type="hidden" name="tenant_id" value={sub.id} />
            <div className="flex flex-col gap-1">
              <label className="eyebrow text-parchment" htmlFor="sub-status">
                Status
              </label>
              <select
                id="sub-status"
                name="status"
                defaultValue={sub.status}
                className={inputCls}
              >
                <option value="trialing">trialing</option>
                <option value="active">active</option>
                <option value="past_due">past_due</option>
                <option value="cancelled">cancelled</option>
              </select>
            </div>
            <Button type="submit" variant="outline" size="sm">
              Set status
            </Button>
          </form>

          <form
            action={setRenewalDateAction}
            className="flex items-center gap-2"
          >
            <input type="hidden" name="tenant_id" value={sub.id} />
            <div className="flex flex-col gap-1">
              <label className="eyebrow text-parchment" htmlFor="sub-renewal-date">
                Renewal date
              </label>
              <input
                id="sub-renewal-date"
                type="date"
                name="period_end"
                defaultValue={
                  sub.currentPeriodEnd ? sub.currentPeriodEnd.slice(0, 10) : ""
                }
                className={inputCls}
              />
            </div>
            <Button type="submit" variant="outline" size="sm">
              Set renewal
            </Button>
          </form>

          <form
            action={setTenantLifecycleAction}
            className="flex items-center gap-2"
          >
            <input type="hidden" name="tenant_id" value={sub.id} />
            <div className="flex flex-col gap-1">
              <label className="eyebrow text-parchment" htmlFor="sub-lifecycle">
                Lifecycle
              </label>
              <select
                id="sub-lifecycle"
                name="tenant_status"
                defaultValue={sub.tenantStatus}
                className={inputCls}
              >
                <option value="active">active</option>
                <option value="suspended">suspended</option>
                <option value="cancelled">cancelled</option>
              </select>
            </div>
            <Button type="submit" variant="outline" size="sm">
              Set lifecycle
            </Button>
          </form>
        </div>
      </Card>

      {/* ── Plan & add-ons ───────────────────────────────────────── */}
      <Card>
        <CardTitle>Plan &amp; add-ons</CardTitle>
        <form
          action={setTenantPlanAction}
          className="mt-4 flex items-center gap-2"
        >
          <input type="hidden" name="tenant_id" value={sub.id} />
          <select
            name="plan_id"
            aria-label="Subscription plan"
            defaultValue={sub.planId ?? ""}
            className={inputCls}
          >
            <option value="">none</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" size="sm">
            Set plan
          </Button>
        </form>

        <div className="mt-4 flex flex-wrap gap-2">
          {addons.map((a) => (
            <form
              key={a.id}
              action={toggleTenantAddonAction}
              className="flex items-center gap-2 rounded-md border border-hair px-2.5 py-1.5 text-xs"
            >
              <input type="hidden" name="tenant_id" value={sub.id} />
              <input type="hidden" name="addon_id" value={a.id} />
              <label className="flex items-center gap-1.5 text-parchment">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={sub.addons.some(
                    (x) => x.addonId === a.id && x.status === "active",
                  )}
                />
                {a.name}
              </label>
              <Button type="submit" variant="outline" size="sm">
                Save
              </Button>
            </form>
          ))}
        </div>
      </Card>

      {/* ── Members ──────────────────────────────────────────────── */}
      <Card>
        <CardTitle>Members</CardTitle>
        <div className="mt-4">
          {sub.members.length === 0 ? (
            <EmptyState title="No members" />
          ) : (
            <Table caption="Members">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {sub.members.map((m) => (
                  <tr key={m.userId}>
                    <Td>{m.fullName ?? "—"}</Td>
                    <Td>{m.email ?? "—"}</Td>
                    <Td>
                      <Badge tone="neutral">{m.role}</Badge>
                    </Td>
                    <Td>{m.status}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      {/* ── Collection (pay-first markets, NG-2) ─────────────────── */}
      {pay && subRow && (
        <>
          <Card>
            <CardTitle>Collection</CardTitle>
            <div className="mt-3">
              <SubscriptionCard status={subStatus} anniversaryOn={subRow.anniversary_on} planName={sub.planName} billedVehicles={subRow.billed_vehicles ?? 0} today={today} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {!openInitial && (subStatus === "unpaid" || subStatus === "cancelled") && (
                <form action={issueInitialInvoiceAction}>
                  <input type="hidden" name="tenant_id" value={sub.id} />
                  <Button type="submit" size="sm">Issue initial invoice</Button>
                </form>
              )}
              {subStatus !== "suspended" && subStatus !== "cancelled" && subStatus !== "unpaid" && (
                <form action={setSubscriptionStateAction}>
                  <input type="hidden" name="tenant_id" value={sub.id} />
                  <input type="hidden" name="state" value="suspend" />
                  <Button type="submit" variant="outline" size="sm">Suspend</Button>
                </form>
              )}
              {(subStatus === "suspended" || subStatus === "past_due") && (
                <form action={setSubscriptionStateAction}>
                  <input type="hidden" name="tenant_id" value={sub.id} />
                  <input type="hidden" name="state" value="reactivate" />
                  <Button type="submit" variant="outline" size="sm">Reactivate</Button>
                </form>
              )}
              {subStatus !== "cancelled" && (
                <form action={setSubscriptionStateAction}>
                  <input type="hidden" name="tenant_id" value={sub.id} />
                  <input type="hidden" name="state" value="cancel" />
                  <Button type="submit" variant="ghost" size="sm">Cancel subscription</Button>
                </form>
              )}
            </div>
            <p className="mt-2 text-xs text-muted">
              Nothing works until money is received: the plan applies once the initial invoice is paid (gateway or a recorded transfer). Renewals, batched additions and reminders run daily.
            </p>
          </Card>

          <Card>
            <CardTitle>Billing contact</CardTitle>
            <form action={saveBillingContactAction} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input type="hidden" name="tenant_id" value={sub.id} />
              <label className="block text-xs text-parchment">Name<input name="billing_name" defaultValue={subRow.billing_name ?? ""} className={`${inputCls} mt-1 w-full`} /></label>
              <label className="block text-xs text-parchment">Email<input name="billing_email" type="email" defaultValue={subRow.billing_email ?? ""} className={`${inputCls} mt-1 w-full`} /></label>
              <label className="block text-xs text-parchment">Phone (SMS reminders)<input name="billing_phone" defaultValue={subRow.billing_phone ?? ""} className={`${inputCls} mt-1 w-full`} /></label>
              <label className="block text-xs text-parchment">Customer TIN<input name="customer_tin" defaultValue={subRow.customer_tin ?? ""} className={`${inputCls} mt-1 w-full`} /></label>
              <label className="block text-xs text-parchment sm:col-span-2">Address<input name="billing_address" defaultValue={subRow.billing_address ?? ""} className={`${inputCls} mt-1 w-full`} /></label>
              <div className="sm:col-span-2"><Button type="submit" variant="outline" size="sm">Save contact</Button></div>
            </form>
          </Card>

          <Card>
            <CardTitle>Invoices</CardTitle>
            <div className="mt-3">
              {invoices.length === 0 ? (
                <EmptyState title="No invoices yet" />
              ) : (
                <Table caption="Subscription invoices">
                  <thead>
                    <tr>
                      <Th>Number</Th>
                      <Th>Kind</Th>
                      <Th>Issued</Th>
                      <Th>Due</Th>
                      <Th>Gross</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <Td><Link href={`/platform/collections/${i.id}`} className="tnum hover:underline">{i.number}</Link></Td>
                        <Td>{i.kind.replace("_", " ")}</Td>
                        <Td>{i.issued_on}</Td>
                        <Td>{i.due_on}</Td>
                        <Td className="tnum">{formatMoney(Number(i.gross_minor), { region })}</Td>
                        <Td><Badge tone={i.status === "paid" ? "profit" : i.status === "void" ? "neutral" : i.status === "overdue" ? "loss" : "info"}>{i.status.replace("_", " ")}</Badge></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </Card>

          <Card>
            <CardTitle>One-off invoice</CardTitle>
            <p className="mb-2 text-xs text-muted">A replacement device, an extra installation. Items and prices come from the catalogue; unpriced items cannot be invoiced.</p>
            <form action={issueOneOffInvoiceAction} className="space-y-2">
              <input type="hidden" name="tenant_id" value={sub.id} />
              {items.length === 0 ? (
                <p className="text-sm text-muted">No one-off items in this market&apos;s catalogue.</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {items.map((a) => (
                    <label key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-hair px-2.5 py-1.5 text-xs text-parchment">
                      <span>
                        {a.name} <span className="text-muted">({isUnpricedItem(a) ? "unpriced" : formatMoney(a.unit_price_pence, { region })})</span>
                      </span>
                      <input name={`qty_${a.id}`} type="number" min="0" defaultValue="0" aria-label={`Quantity of ${a.name}`} className={`${inputCls} w-16`} disabled={isUnpricedItem(a) || !a.active} />
                    </label>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <label className="block text-xs text-parchment">Note<input name="note" className={`${inputCls} mt-1 w-64`} /></label>
                <Button type="submit" variant="outline" size="sm" disabled={items.length === 0}>Issue one-off invoice</Button>
              </div>
            </form>
          </Card>

          <Card>
            <CardTitle>Timeline</CardTitle>
            {events.length === 0 ? (
              <EmptyState title="No events yet" />
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm text-parchment">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="tnum text-muted">{new Date(e.created_at).toISOString().replace("T", " ").slice(0, 16)}</span>
                    <span className="text-cream">{e.kind.replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {/* ── Hardware (managed product, NG-3) ─────────────────────── */}
      {hardwareBuild && (
        <Card>
          <CardTitle>Hardware</CardTitle>
          <p className="mb-3 text-sm text-muted">
            Trackers fitted to this subscriber&apos;s vehicles and the jobs still open. Jobs come from paid invoices; raise one by hand only for a visit nobody has
            paid for (a goodwill service, a removal).
          </p>
          {fleet.length === 0 ? (
            <EmptyState title="No vehicles yet" />
          ) : (
            <Table caption="Vehicles and trackers">
              <thead>
                <tr>
                  <Th>Vehicle</Th>
                  <Th>Tracker</Th>
                  <Th>Relay</Th>
                  <Th>First position</Th>
                  <Th>Warranty to</Th>
                  <Th>Open job</Th>
                </tr>
              </thead>
              <tbody>
                {fleet.map((v) => {
                  const d = deviceByVehicle.get(v.id);
                  const j = jobByVehicle.get(v.id);
                  return (
                    <tr key={v.id}>
                      <Td>
                        <span className="text-cream">{v.registration}</span> <span className="text-muted">{v.make}</span>
                      </Td>
                      <Td>
                        {!d ? (
                          <span className="text-muted">none</span>
                        ) : d.kind === "phone" ? (
                          <Badge tone="neutral">phone</Badge>
                        ) : (
                          <span>
                            {d.unit?.model ?? "tracker"} <span className="tnum text-muted">{d.unit?.imei ?? ""}</span> <Badge tone={d.state === "fitted" ? "profit" : "warn"}>{d.state}</Badge>
                          </span>
                        )}
                      </Td>
                      <Td>{d?.unit?.has_immobiliser ? <Badge tone="gold">immobiliser</Badge> : <span className="text-muted">—</span>}</Td>
                      <Td>{d?.first_ping_at ? fmtDate(d.first_ping_at) : d?.kind === "hardware" ? <Badge tone="warn">never</Badge> : "—"}</Td>
                      <Td>{d?.warranty_until ? fmtDate(d.warranty_until) : "—"}</Td>
                      <Td>
                        {j ? (
                          <Link href={`/platform/hardware/jobs/${j.id}`} className="text-gold-bright hover:underline">
                            {KIND_NOUN[j.kind]} · {j.status.replace("_", " ")}
                          </Link>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {fleet.length > 0 && (
            <details className="mt-4 rounded-lg border border-hair">
              <summary className="cursor-pointer px-4 py-2 text-sm text-parchment">Raise a job by hand</summary>
              <form action={createManualJobAction} className="flex flex-wrap items-end gap-3 p-4">
                <input type="hidden" name="tenant_id" value={sub.id} />
                <input type="hidden" name="return_to" value={`/platform/subscribers/${sub.id}`} />
                <label className="block text-xs text-parchment">
                  <span className="mb-1 block font-semibold uppercase tracking-wider">Vehicle</span>
                  <select name="vehicle_id" className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream">
                    {fleet.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.registration}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-parchment">
                  <span className="mb-1 block font-semibold uppercase tracking-wider">Job</span>
                  <select name="kind" className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream">
                    <option value="service">service visit</option>
                    <option value="remove">removal</option>
                    <option value="install">install</option>
                    <option value="replace">replace</option>
                  </select>
                </label>
                <label className="block text-xs text-parchment">
                  <span className="mb-1 block font-semibold uppercase tracking-wider">Note</span>
                  <input name="note" className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream" placeholder="Why this visit" />
                </label>
                <Button type="submit" size="sm" variant="outline">
                  Raise job
                </Button>
              </form>
            </details>
          )}
        </Card>
      )}

      {/* ── Billing (Stripe) — UK SaaS ───────────────────────────── */}
      {!pay && (
      <Card>
        <CardTitle>Billing (Stripe)</CardTitle>
        <div className="mt-4">
          {sub.billing ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="eyebrow text-parchment">Customer ID</dt>
                <dd className="mt-1 text-sm text-cream tnum">
                  {sub.billing.stripe_customer_id ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="eyebrow text-parchment">Subscription ID</dt>
                <dd className="mt-1 text-sm text-cream tnum">
                  {sub.billing.stripe_subscription_id ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="eyebrow text-parchment">Status</dt>
                <dd className="mt-1 text-sm text-cream">
                  {sub.billing.subscription_status ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="eyebrow text-parchment">Period end</dt>
                <dd className="mt-1 text-sm text-cream">
                  {fmtDate(sub.billing.current_period_end)}
                </dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              title="No Stripe billing linked"
              hint="Billing activates when Stripe is configured."
            />
          )}
        </div>
      </Card>
      )}

      {/* ── Reminders ────────────────────────────────────────────── */}
      <Card>
        <CardTitle>Reminders</CardTitle>
        <form
          action={sendReminderNowAction}
          className="mt-4 flex items-end gap-2"
        >
          <input type="hidden" name="tenant_id" value={sub.id} />
          <div className="flex flex-col gap-1">
            <label className="eyebrow text-parchment" htmlFor="reminder-kind">
              Send reminder now
            </label>
            <select id="reminder-kind" name="kind" defaultValue="renewal_upcoming" className={inputCls}>
              <option value="renewal_upcoming">renewal_upcoming</option>
              <option value="trial_ending">trial_ending</option>
              <option value="past_due">past_due</option>
            </select>
          </div>
          <Button type="submit" variant="outline" size="sm">
            Send
          </Button>
        </form>

        <div className="mt-4">
          {sub.reminders.length === 0 ? (
            <EmptyState title="No reminders sent yet" />
          ) : (
            <Table caption="Reminders sent">
              <thead>
                <tr>
                  <Th>Kind</Th>
                  <Th>Sent</Th>
                  <Th>Status</Th>
                  <Th>Recipient</Th>
                </tr>
              </thead>
              <tbody>
                {sub.reminders.map((r, i) => (
                  <tr key={`${r.kind}-${r.sent_at}-${i}`}>
                    <Td>{r.kind}</Td>
                    <Td>{fmtDate(r.sent_at)}</Td>
                    <Td>
                      <Badge tone="neutral">{r.status}</Badge>
                    </Td>
                    <Td>{r.recipient ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      {/* ── Health ───────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Health</CardTitle>
          <Badge tone={healthTone}>
            {sub.health.band.replace("_", " ")} · {sub.health.score}
          </Badge>
        </div>
        <div className="mt-4">
          {sub.health.reasons.length === 0 ? (
            <p className="text-sm text-muted">
              No health flags — this subscriber looks healthy.
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm text-parchment">
              {sub.health.reasons.map((reason, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-gold-bright">•</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
