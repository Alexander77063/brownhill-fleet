"use server";

/**
 * Platform-console actions for hardware operations (NG-3). Every action begins
 * with requirePlatformAdmin(). Money typed by an admin is in major units and
 * converted with the region pack, never a literal. Outcomes are carried back
 * to the page as a message, not thrown at an error boundary.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/context";
import { platformSettings } from "@/lib/collection/settings";
import { executeImmobilise } from "@/lib/hardware/commands";
import { JOB_KINDS, type JobKind, type UnitEvent } from "@/lib/hardware/derive";
import { saveInstaller } from "@/lib/hardware/installers";
import {
  cancelJob,
  completeJob,
  createHardwareJobs,
  createManualJob,
  failJob,
  jobById,
  type JobPhoto,
  raiseReplacementInvoice,
  scheduleJob,
  startJob,
} from "@/lib/hardware/jobs";
import { PHOTO_MAX_BYTES, putJobPhoto } from "@/lib/hardware/photos";
import { localToISO } from "@/lib/hardware/time";
import { traccarClient } from "@/lib/hardware/traccar";
import { addUnits, moveUnit, type NewUnit, parseUnitsCsv, registerPendingUnits } from "@/lib/hardware/units";
import type { ImmobiliseAction } from "@/lib/immobilise";
import { regionProvider } from "@/lib/region";

const HARDWARE = "/platform/hardware";
const UNIT_EVENTS: readonly UnitEvent[] = ["allocate", "fit", "fault", "return", "restock", "retire", "lose"];

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** An admin types major units ("15000" naira); the store is minor units. */
const minorFromMajor = (v: string) => Math.round(Number(v || 0) * regionProvider().currency.minorPerMajor);
const feeField = (fd: FormData, k: string): number | undefined => {
  const v = str(fd, k);
  return v === "" ? undefined : minorFromMajor(v);
};
const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function toTab(tab: string, msg: string, isError = false): never {
  redirect(`${HARDWARE}?tab=${tab}&${isError ? "error" : "msg"}=${encodeURIComponent(msg)}`);
}
function toJob(id: string, msg: string, isError = false): never {
  revalidatePath(HARDWARE);
  redirect(`${HARDWARE}/jobs/${id}?${isError ? "error" : "msg"}=${encodeURIComponent(msg)}`);
}

// ── Inventory ────────────────────────────────────────────────────────────────

export async function addUnitsAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  let outcome: string;
  let failed = false;
  try {
    const csv = str(formData, "csv");
    let rows: NewUnit[];
    let parseErrors: string[] = [];
    if (csv) {
      ({ rows, errors: parseErrors } = parseUnitsCsv(csv));
    } else {
      rows = [
        {
          imei: str(formData, "imei"),
          model: str(formData, "model") || null,
          vendor: str(formData, "vendor") || null,
          iccid: str(formData, "iccid") || null,
          msisdn: str(formData, "msisdn") || null,
          hasImmobiliser: formData.get("has_immobiliser") === "on",
          batchRef: str(formData, "batch_ref") || null,
          purchasedOn: str(formData, "purchased_on") || null,
          unitCostMinor: minorFromMajor(str(formData, "unit_cost")),
          notes: str(formData, "notes") || null,
        },
      ];
    }
    const r = await addUnits(rows, userId, { traccar: traccarClient() });
    const bits = [`Added ${r.added}.`];
    if (r.skipped.length) bits.push(`Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.imei} (${s.reason})`).join(", ")}.`);
    if (r.traccarPending) bits.push(`${r.traccarPending} awaiting gateway registration.`);
    if (parseErrors.length) bits.push(`CSV problems: ${parseErrors.join(" ")}`);
    outcome = bits.join(" ");
    failed = r.added === 0;
  } catch (e) {
    outcome = errText(e);
    failed = true;
  }
  toTab("inventory", outcome, failed);
}

export async function moveUnitAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const unitId = str(formData, "unit_id");
  const event = str(formData, "event") as UnitEvent;
  if (!UNIT_EVENTS.includes(event)) toTab("inventory", "Unknown stock move.", true);
  try {
    const to = await moveUnit(unitId, event, userId, { note: str(formData, "note") || null });
    toTab("inventory", `Unit is now ${to.replace("_", " ")}.`);
  } catch (e) {
    toTab("inventory", errText(e), true);
  }
}

export async function registerPendingUnitsAction(): Promise<void> {
  await requirePlatformAdmin();
  const traccar = traccarClient();
  if (!traccar.configured()) toTab("inventory", "The tracking gateway is not configured.", true);
  const r = await registerPendingUnits(traccar);
  toTab("inventory", `Registered ${r.registered} with the gateway${r.failed ? `; ${r.failed} failed (see server log)` : ""}.`, r.failed > 0 && r.registered === 0);
}

// ── Installers ───────────────────────────────────────────────────────────────

export async function saveInstallerAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  try {
    await saveInstaller({
      id: str(formData, "id") || undefined,
      name: str(formData, "name"),
      phone: str(formData, "phone"),
      email: str(formData, "email") || null,
      city: str(formData, "city") || null,
      kind: str(formData, "kind") === "own" ? "own" : "partner",
      fees: { install: feeField(formData, "fee_install"), replace: feeField(formData, "fee_replace"), remove: feeField(formData, "fee_remove"), service: feeField(formData, "fee_service") },
      active: formData.get("active") !== "off" && (formData.has("active") ? formData.get("active") === "on" : true),
      notes: str(formData, "notes") || null,
    });
    toTab("installers", "Installer saved.");
  } catch (e) {
    toTab("installers", errText(e), true);
  }
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export async function scheduleJobAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  try {
    await scheduleJob(
      id,
      {
        installerId: str(formData, "installer_id"),
        scheduledAt: localToISO(str(formData, "scheduled_at"), regionProvider().timezone),
        address: str(formData, "address") || null,
        contactName: str(formData, "contact_name") || null,
        contactPhone: str(formData, "contact_phone") || null,
      },
      userId,
    );
    toJob(id, "Booked. The customer and the installer have been texted.");
  } catch (e) {
    toJob(id, errText(e), true);
  }
}

export async function startJobAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  try {
    await startJob(id, userId);
    toJob(id, "Marked in progress.");
  } catch (e) {
    toJob(id, errText(e), true);
  }
}

export async function completeJobAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  try {
    const job = await jobById(id);
    if (!job) throw new Error("Job not found.");
    const settings = await platformSettings();
    const checklist: Record<string, boolean> = {};
    settings["hardware.checklist"].forEach((item, i) => {
      checklist[item] = formData.get(`check_${i}`) === "on";
    });
    const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
    const photos: JobPhoto[] = [];
    for (const [i, file] of files.entries()) {
      if (file.size > PHOTO_MAX_BYTES) throw new Error(`${file.name} is larger than ${Math.round(PHOTO_MAX_BYTES / 1_048_576)} MB.`);
      if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
      photos.push(await putJobPhoto(job.tenantId, id, i, file, null));
    }
    const outcome = str(formData, "old_unit_outcome");
    await completeJob(
      id,
      {
        unitImei: str(formData, "unit_imei") || null,
        checklist,
        photos,
        notes: str(formData, "notes") || null,
        oldUnitOutcome: outcome === "lost" || outcome === "returned" || outcome === "faulty" ? outcome : undefined,
      },
      userId,
    );
    toJob(id, "Done. The customer has been texted.");
  } catch (e) {
    toJob(id, errText(e), true);
  }
}

export async function failJobAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  try {
    await failJob(id, str(formData, "reason"), userId);
    toJob(id, "Recorded as a failed visit. Book it again when ready.");
  } catch (e) {
    toJob(id, errText(e), true);
  }
}

export async function cancelJobAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  try {
    await cancelJob(id, str(formData, "reason"), userId);
    toJob(id, "Cancelled.");
  } catch (e) {
    toJob(id, errText(e), true);
  }
}

export async function raiseReplacementInvoiceAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const id = str(formData, "id");
  try {
    const r = await raiseReplacementInvoice(id, userId);
    revalidatePath("/platform/collections");
    toJob(id, `Invoice ${r.number} issued and sent. The job is released when it is paid.`);
  } catch (e) {
    toJob(id, errText(e), true);
  }
}

export async function createManualJobAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const tenantId = str(formData, "tenant_id");
  const kind = str(formData, "kind") as JobKind;
  const returnTo = str(formData, "return_to") || `/platform/subscribers/${tenantId}`;
  if (!JOB_KINDS.includes(kind)) redirect(`${returnTo}?error=${encodeURIComponent("Unknown job kind.")}`);
  try {
    const { id } = await createManualJob(tenantId, str(formData, "vehicle_id"), kind, str(formData, "note") || null, userId);
    revalidatePath(returnTo);
    toJob(id, "Job raised. Book an installer when ready.");
  } catch (e) {
    redirect(`${returnTo}?error=${encodeURIComponent(errText(e))}`);
  }
}

/** Re-run the derivation for a paid invoice (idempotent) — after a failure logged on its timeline. */
export async function deriveJobsAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const invoiceId = str(formData, "invoice_id");
  const returnTo = str(formData, "return_to") || `/platform/collections/${invoiceId}`;
  try {
    const r = await createHardwareJobs(invoiceId);
    revalidatePath(HARDWARE);
    revalidatePath(returnTo);
    redirect(`${returnTo}?msg=${encodeURIComponent(`Jobs: ${r.created} created, ${r.existing} already existed${r.shortfall ? `, ${r.shortfall} could not be placed` : ""}.`)}`);
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // the redirect above
    redirect(`${returnTo}?error=${encodeURIComponent(errText(e))}`);
  }
}

// ── Immobilisation (on-call, from an acknowledged request) ───────────────────

export async function executeImmobiliseAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const requestId = str(formData, "request_id");
  const action: ImmobiliseAction = str(formData, "action") === "release" ? "release" : "immobilise";
  const page = `/platform/assistance/${requestId}`;
  try {
    const r = await executeImmobilise({ requestId, action, executedBy: userId });
    revalidatePath(page);
    const verb = action === "immobilise" ? "Engine cut" : "Release";
    if (r.delivered) {
      redirect(`${page}?msg=${encodeURIComponent(`${verb} ${r.status === "pending" ? "queued — the tracker is offline; it will apply when it reconnects" : "sent"}${r.speedKph != null ? ` (vehicle at ${r.speedKph} km/h)` : ""}.`)}`);
    }
    redirect(`${page}?error=${encodeURIComponent(`${verb} not sent: ${r.reasonText ?? r.reason ?? "refused"}`)}`);
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // the redirect above
    redirect(`${page}?error=${encodeURIComponent(errText(e))}`);
  }
}
