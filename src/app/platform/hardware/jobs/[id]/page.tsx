import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Button, Badge } from "@/components/ui";
import { cancelJobAction, completeJobAction, failJobAction, raiseReplacementInvoiceAction, scheduleJobAction, startJobAction } from "@/lib/actions/hardware";
import { platformSettings } from "@/lib/collection/settings";
import { formatDate, relativeTime } from "@/lib/display";
import { timelineForJob } from "@/lib/hardware/events";
import { listInstallers } from "@/lib/hardware/installers";
import { jobById } from "@/lib/hardware/jobs";
import { KIND_NOUN, whenText } from "@/lib/hardware/notify";
import { jobPhotoUrl } from "@/lib/hardware/photos";
import { isoToLocal } from "@/lib/hardware/time";
import { fittableUnits } from "@/lib/hardware/units";
import { formatMoney } from "@/lib/money";
import { regionProvider } from "@/lib/region";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePlatformAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const sb = createServiceClient();
  const job = await jobById(id, sb);
  if (!job) notFound();
  const region = regionProvider();
  const today = new Date().toISOString().slice(0, 10);
  const [timeline, installers, units, settings, { data: log }] = await Promise.all([
    timelineForJob(id, sb),
    listInstallers({ activeOnly: true }, sb),
    fittableUnits(sb),
    platformSettings(sb),
    sb.from("notifications").select("channel, recipient, subject, status, error, created_at").eq("entity_type", "hardware_job").eq("entity_id", id).order("created_at"),
  ]);
  const photoUrls = await Promise.all(job.photos.map((p) => jobPhotoUrl(p)));

  const open = ["pending", "scheduled", "in_progress"].includes(job.status);
  const awaitingPayment = Boolean(job.detail.awaiting_payment);
  const canSchedule = open && job.status !== "in_progress" && !awaitingPayment;
  const canStart = job.status === "scheduled";
  const canComplete = open && !awaitingPayment;
  const canFail = job.status === "scheduled" || job.status === "in_progress";
  const canCancel = ["pending", "scheduled", "failed"].includes(job.status);
  const needsUnit = job.kind === "install" || job.kind === "replace";
  const takesOldUnit = job.kind === "replace" || job.kind === "remove" || job.kind === "service";
  const canInvoice = open && job.underWarranty === false && (job.kind === "service" || job.kind === "replace") && !job.invoiceId;
  const overdue = job.slaDueOn && job.slaDueOn < today && open;
  const defaultWhen = isoToLocal(job.scheduledAt ?? new Date(Date.now() + 24 * 3_600_000).toISOString(), region.timezone);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Hardware"
        title={`${KIND_NOUN[job.kind]} · ${job.vehicle?.registration ?? "no vehicle"}`}
        subtitle={`${job.tenantName} · ${job.vehicle ? `${job.vehicle.make ?? ""} ${job.vehicle.model ?? ""}`.trim() : ""} · raised ${relativeTime(job.createdAt)} from ${job.source}${job.invoiceNumber ? ` (${job.invoiceNumber})` : ""}`}
        actions={
          <Button href="/platform/hardware" variant="ghost" size="sm">
            All jobs
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
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={job.status === "done" ? "profit" : job.status === "failed" ? "loss" : overdue ? "loss" : "gold"}>{job.status.replace("_", " ")}</Badge>
            {awaitingPayment && <Badge tone="warn">awaiting payment</Badge>}
            {job.underWarranty === true && <Badge tone="profit">under warranty</Badge>}
            {job.underWarranty === false && <Badge tone="warn">out of warranty</Badge>}
            {job.slaDueOn && (
              <span className={overdue ? "text-[var(--color-loss)]" : "text-muted"}>
                SLA {formatDate(job.slaDueOn)}
                {overdue ? " — overdue" : ""}
              </span>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Installer</dt>
            <dd className="text-cream">{job.installer ? `${job.installer.name} · ${job.installer.phone}` : "—"}</dd>
            <dt className="text-muted">Booked for</dt>
            <dd className="text-cream">{job.scheduledAt ? whenText(job.scheduledAt) : "—"}</dd>
            <dt className="text-muted">Address</dt>
            <dd className="text-cream">{job.address ?? "—"}</dd>
            <dt className="text-muted">Contact</dt>
            <dd className="text-cream">{[job.contactName, job.contactPhone].filter(Boolean).join(" · ") || "—"}</dd>
            <dt className="text-muted">Installer fee</dt>
            <dd className="text-cream">{job.feeMinor != null ? formatMoney(job.feeMinor, { region: region.id }) : "—"}</dd>
            <dt className="text-muted">Unit</dt>
            <dd className="tnum text-cream">{job.unitImei ?? "—"}</dd>
            {job.invoiceId && (
              <>
                <dt className="text-muted">Invoice</dt>
                <dd>
                  <Link href={`/platform/collections/${job.invoiceId}`} className="text-gold-bright hover:underline">
                    {job.invoiceNumber ?? "open"}
                  </Link>
                </dd>
              </>
            )}
            {job.requestId && (
              <>
                <dt className="text-muted">Request</dt>
                <dd>
                  <Link href={`/platform/assistance/${job.requestId}`} className="text-gold-bright hover:underline">
                    owner request
                  </Link>
                </dd>
              </>
            )}
            {job.notes && (
              <>
                <dt className="text-muted">Notes</dt>
                <dd className="text-cream">{job.notes}</dd>
              </>
            )}
            {job.failureReason && (
              <>
                <dt className="text-muted">{job.status === "cancelled" ? "Cancelled" : "Failed"}</dt>
                <dd className="text-cream">{job.failureReason}</dd>
              </>
            )}
          </dl>
          {Object.keys(job.detail).length > 0 && job.detail.alarm ? <p className="mt-2 text-xs text-muted">Alarm: {String(job.detail.alarm)}</p> : null}
          {job.detail.note ? <p className="mt-2 text-xs text-muted">{String(job.detail.note)}</p> : null}

          {canInvoice && (
            <form action={raiseReplacementInvoiceAction} className="mt-4">
              <input type="hidden" name="id" value={job.id} />
              <Button type="submit" size="sm" variant="primary">
                Raise replacement invoice
              </Button>
              <p className="mt-1 text-xs text-muted">Out of warranty: the customer pays before anyone is dispatched. The job is released when the invoice is paid.</p>
            </form>
          )}
          {awaitingPayment && <p className="mt-3 text-sm text-parchment">Waiting for invoice {job.invoiceNumber ?? ""} to be paid. Nothing can be booked until then.</p>}

          {canSchedule && (
            <form action={scheduleJobAction} className="mt-4 space-y-3 border-t border-hair-soft pt-4">
              <input type="hidden" name="id" value={job.id} />
              <p className="text-sm font-semibold text-cream">{job.status === "failed" ? "Book again" : job.status === "scheduled" ? "Rebook" : "Book an installer"}</p>
              {installers.length === 0 ? (
                <p className="text-sm text-[var(--color-loss)]">
                  No active installer.{" "}
                  <Link href="/platform/hardware?tab=installers" className="underline">
                    Add one
                  </Link>
                  .
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Installer">
                    <select name="installer_id" defaultValue={job.installerId ?? installers[0].id} className={`${inputCls} w-full`}>
                      {installers.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                          {i.city ? ` · ${i.city}` : ""}
                          {i.fees[job.kind] != null ? ` · ${formatMoney(i.fees[job.kind] as number, { region: region.id })}` : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`When (${region.timezone})`}>
                    <input name="scheduled_at" type="datetime-local" required defaultValue={defaultWhen} className={`${inputCls} w-full`} />
                  </Field>
                  <Field label="Address">
                    <input name="address" defaultValue={job.address ?? ""} className={`${inputCls} w-full`} />
                  </Field>
                  <Field label="Contact name">
                    <input name="contact_name" defaultValue={job.contactName ?? ""} className={`${inputCls} w-full`} />
                  </Field>
                  <Field label="Contact phone" hint="Defaults to the vehicle owner's number.">
                    <input name="contact_phone" defaultValue={job.contactPhone ?? ""} className={`${inputCls} w-full`} />
                  </Field>
                  <div className="self-end">
                    <Button type="submit" size="sm" variant="primary">
                      Book and text both
                    </Button>
                  </div>
                </div>
              )}
            </form>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {canStart && (
              <form action={startJobAction}>
                <input type="hidden" name="id" value={job.id} />
                <Button type="submit" size="sm" variant="outline">
                  Installer on site
                </Button>
              </form>
            )}
            {canFail && (
              <form action={failJobAction} className="flex items-end gap-2">
                <input type="hidden" name="id" value={job.id} />
                <Field label="Visit failed because">
                  <input name="reason" required className={`${inputCls} w-56`} />
                </Field>
                <Button type="submit" size="sm" variant="ghost">
                  Record failed visit
                </Button>
              </form>
            )}
            {canCancel && (
              <form action={cancelJobAction} className="flex items-end gap-2">
                <input type="hidden" name="id" value={job.id} />
                <Field label="Cancel because">
                  <input name="reason" className={`${inputCls} w-56`} />
                </Field>
                <Button type="submit" size="sm" variant="ghost">
                  Cancel job
                </Button>
              </form>
            )}
          </div>
        </Card>

        <Card>
          <CardTitle>{canComplete ? "Complete the job" : "Completion"}</CardTitle>
          {canComplete ? (
            <form action={completeJobAction} className="space-y-3" encType="multipart/form-data">
              <input type="hidden" name="id" value={job.id} />
              {job.kind !== "remove" && (
                <Field label={needsUnit ? "Unit fitted (IMEI)" : "Unit fitted, if swapped (IMEI)"} hint="Stock, oldest first. Type an IMEI if it is not listed.">
                  <input name="unit_imei" list="fittable" required={needsUnit} inputMode="numeric" className={`${inputCls} w-full`} />
                  <datalist id="fittable">
                    {units.map((u) => (
                      <option key={u.id} value={u.imei}>
                        {u.model ?? "unit"}
                        {u.hasImmobiliser ? " · relay" : ""}
                        {u.traccarPending ? " · not registered" : ""}
                      </option>
                    ))}
                  </datalist>
                </Field>
              )}
              {takesOldUnit && (
                <Field label="The unit taken off the vehicle">
                  <select name="old_unit_outcome" defaultValue={job.kind === "remove" ? "returned" : "faulty"} className={`${inputCls} w-full`}>
                    <option value="faulty">faulty — keep for RMA</option>
                    <option value="returned">returned — test and restock</option>
                    <option value="lost">lost / not recovered</option>
                  </select>
                </Field>
              )}
              {job.kind !== "remove" && (
                <fieldset className="space-y-1">
                  <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-parchment">Installer checklist</legend>
                  {settings["hardware.checklist"].map((item, i) => (
                    <label key={item} className="flex items-center gap-2 text-sm text-parchment">
                      <input type="checkbox" name={`check_${i}`} /> {item}
                    </label>
                  ))}
                </fieldset>
              )}
              <Field label={job.kind === "remove" ? "Photos (optional)" : "Photos of the fitted unit (at least one)"}>
                <input name="photos" type="file" accept="image/*" multiple className="block text-sm text-parchment" />
              </Field>
              <Field label="Notes">
                <textarea name="notes" rows={2} className={`${inputCls} w-full`} />
              </Field>
              <Button type="submit" size="sm" variant="primary">
                Mark done and text the customer
              </Button>
            </form>
          ) : job.status === "done" ? (
            <div className="space-y-3 text-sm">
              <p className="text-parchment">
                Done {job.completedAt ? relativeTime(job.completedAt) : ""}
                {job.unitImei ? ` · unit ${job.unitImei}` : ""}
              </p>
              {settings["hardware.checklist"].length > 0 && (
                <ul className="space-y-0.5">
                  {settings["hardware.checklist"].map((item) => (
                    <li key={item} className={job.checklist[item] ? "text-parchment" : "text-muted line-through"}>
                      {job.checklist[item] ? "✓" : "–"} {item}
                    </li>
                  ))}
                </ul>
              )}
              {job.photos.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {job.photos.map((p, i) => (
                    <li key={p.path}>
                      {photoUrls[i] ? (
                        <a href={photoUrls[i] as string} target="_blank" rel="noreferrer" className="text-gold-bright underline">
                          photo {i + 1}
                        </a>
                      ) : (
                        <span className="text-muted">photo {i + 1} (unavailable)</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">{awaitingPayment ? "Available once the invoice is paid." : "This job is closed."}</p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Timeline</CardTitle>
          {timeline.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-hair text-sm">
              {timeline.map((e) => (
                <li key={e.id} className="py-1.5">
                  <span className="text-xs text-muted">
                    {formatDate(e.createdAt.slice(0, 10))} {e.createdAt.slice(11, 16)}
                  </span>{" "}
                  <span className="text-cream">{e.kind.replace(/_/g, " ")}</span> <span className="text-xs text-muted">by {e.actor}</span>
                  {Object.keys(e.detail).length > 0 && <span className="ml-2 text-xs text-muted">{JSON.stringify(e.detail)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardTitle>Messages sent</CardTitle>
          {(log ?? []).length === 0 ? (
            <p className="text-sm text-muted">None yet.</p>
          ) : (
            <ul className="divide-y divide-hair text-sm">
              {(log ?? []).map((n, i) => (
                <li key={`${n.created_at}-${i}`} className="py-1.5">
                  <span className="text-xs text-muted">{n.created_at.slice(11, 16)}</span> {n.subject} → {n.recipient ?? "nobody"}{" "}
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
