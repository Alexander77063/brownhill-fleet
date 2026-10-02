/**
 * Hardware jobs — the work a paid invoice (or a fault) creates: fit, replace,
 * remove, service a tracker on one vehicle. Money comes first: jobs exist only
 * for paid lines, and a replacement outside warranty is invoiced before it is
 * scheduled. Completion is the ONE path that binds a stock unit to a vehicle.
 */
import { buildOneOffDraft, invoiceById, issueInvoice, recordEvent, todayISO } from '@/lib/collection/invoices';
import { notifyInvoiceIssued } from '@/lib/collection/notify-invoice';
import { platformSettings } from '@/lib/collection/settings';
import { deploymentBrand } from '@/lib/deployment/brand';
import { getVehicleDevice, provisionDevice, removeVehicleDevice } from '@/lib/gps';
import { regionProvider } from '@/lib/region';
import { createServiceClient } from '@/lib/supabase/server';
import {
  deriveJobs,
  type JobKind,
  type JobStatus,
  OPEN_JOB_STATUSES,
  slaDueOn,
  underWarranty,
  type UnitState,
  type VehicleForJobs,
  warrantyUntil,
} from './derive';
import { hardwareEvent } from './events';
import { feeFor, installerById } from './installers';
import type { JobPhoto } from './photos';
import { completedCustomerText, customerPhoneFor, jobsCreatedText, scheduledCustomerText, scheduledInstallerText, smsAboutJob } from './notify';
import { moveUnit } from './units';

type Sb = ReturnType<typeof createServiceClient>;

export type JobSource = 'invoice' | 'fault' | 'alarm' | 'manual';

export type { JobPhoto } from './photos';

export interface JobRow {
  id: string;
  tenantId: string;
  tenantName: string;
  vehicleId: string | null;
  vehicle: { registration: string; make: string | null; model: string | null } | null;
  kind: JobKind;
  status: JobStatus;
  source: JobSource;
  invoiceId: string | null;
  invoiceNumber: string | null;
  addonIds: string[];
  requestId: string | null;
  installerId: string | null;
  installer: { name: string; phone: string } | null;
  scheduledAt: string | null;
  address: string | null;
  contactName: string | null;
  contactPhone: string | null;
  slaDueOn: string | null;
  unitId: string | null;
  unitImei: string | null;
  deviceId: string | null;
  replacedDeviceId: string | null;
  underWarranty: boolean | null;
  feeMinor: number | null;
  checklist: Record<string, boolean>;
  photos: JobPhoto[];
  detail: Record<string, unknown>;
  notes: string | null;
  failureReason: string | null;
  completedAt: string | null;
  completedBy: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const JOB_SELECT = '*, vehicles(registration, make, model), tenants(name), installers(name, phone), device_units(imei), subscription_invoices(number)';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pick(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function toJob(r: Record<string, unknown>): JobRow {
  const veh = pick(r.vehicles) as { registration: string; make: string | null; model: string | null } | null;
  const ten = pick(r.tenants) as { name: string } | null;
  const ins = pick(r.installers) as { name: string; phone: string } | null;
  const unit = pick(r.device_units) as { imei: string } | null;
  const inv = pick(r.subscription_invoices) as { number: string } | null;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    tenantName: ten?.name ?? '',
    vehicleId: (r.vehicle_id as string | null) ?? null,
    vehicle: veh,
    kind: r.kind as JobKind,
    status: r.status as JobStatus,
    source: r.source as JobSource,
    invoiceId: (r.invoice_id as string | null) ?? null,
    invoiceNumber: inv?.number ?? null,
    addonIds: (r.addon_ids as string[]) ?? [],
    requestId: (r.request_id as string | null) ?? null,
    installerId: (r.installer_id as string | null) ?? null,
    installer: ins,
    scheduledAt: (r.scheduled_at as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    contactPhone: (r.contact_phone as string | null) ?? null,
    slaDueOn: (r.sla_due_on as string | null) ?? null,
    unitId: (r.unit_id as string | null) ?? null,
    unitImei: unit?.imei ?? null,
    deviceId: (r.device_id as string | null) ?? null,
    replacedDeviceId: (r.replaced_device_id as string | null) ?? null,
    underWarranty: (r.under_warranty as boolean | null) ?? null,
    feeMinor: r.fee_minor == null ? null : Number(r.fee_minor),
    checklist: (r.checklist as Record<string, boolean>) ?? {},
    photos: (r.photos as JobPhoto[]) ?? [],
    detail: (r.detail as Record<string, unknown>) ?? {},
    notes: (r.notes as string | null) ?? null,
    failureReason: (r.failure_reason as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    completedBy: (r.completed_by as string | null) ?? null,
    cancelledAt: (r.cancelled_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

async function loadJob(id: string, sb: Sb): Promise<JobRow> {
  const job = await jobById(id, sb);
  if (!job) throw new Error('Job not found.');
  return job;
}

async function patchJob(sb: Sb, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await sb
    .from('hardware_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() } as never)
    .eq('id', id);
  if (error) throw new Error(`job update: ${error.message}`);
}

export async function jobById(id: string, sb: Sb = createServiceClient()): Promise<JobRow | null> {
  const { data } = await sb.from('hardware_jobs').select(JOB_SELECT).eq('id', id).maybeSingle();
  return data ? toJob(data as unknown as Record<string, unknown>) : null;
}

export interface JobFilter {
  scope?: 'open' | 'closed' | 'all';
  tenantId?: string;
  vehicleId?: string;
  kind?: JobKind;
  status?: JobStatus;
  limit?: number;
}

export async function listJobs(filter: JobFilter = {}, sb: Sb = createServiceClient()): Promise<JobRow[]> {
  let q = sb.from('hardware_jobs').select(JOB_SELECT).order('created_at', { ascending: false }).limit(filter.limit ?? 500);
  const scope = filter.scope ?? 'open';
  if (filter.status) q = q.eq('status', filter.status);
  else if (scope === 'open') q = q.in('status', [...OPEN_JOB_STATUSES]);
  else if (scope === 'closed') q = q.in('status', ['done', 'failed', 'cancelled']);
  if (filter.tenantId) q = q.eq('tenant_id', filter.tenantId);
  if (filter.vehicleId) q = q.eq('vehicle_id', filter.vehicleId);
  if (filter.kind) q = q.eq('kind', filter.kind);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toJob);
}

/** Open jobs past their SLA day. */
export async function overdueJobs(today: string, sb: Sb = createServiceClient()): Promise<JobRow[]> {
  const { data, error } = await sb
    .from('hardware_jobs')
    .select(JOB_SELECT)
    .in('status', [...OPEN_JOB_STATUSES])
    .lt('sla_due_on', today)
    .order('sla_due_on');
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toJob);
}

export interface SilentFittedDevice {
  deviceId: string;
  tenantId: string;
  tenantName: string;
  vehicleId: string;
  registration: string;
  fittedAt: string;
  imei: string | null;
}

/** Devices fitted more than `hours` ago that have never sent a position. */
export async function fittedNotReporting(hours: number, sb: Sb = createServiceClient(), now: Date = new Date()): Promise<SilentFittedDevice[]> {
  const cutoff = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const { data } = await sb
    .from('telematics_devices')
    .select('id, tenant_id, vehicle_id, fitted_at, vehicles(registration), tenants(name), device_units(imei)')
    .eq('state', 'fitted')
    .is('removed_at', null)
    .is('first_ping_at', null)
    .not('unit_id', 'is', null)
    .lt('fitted_at', cutoff)
    .order('fitted_at');
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    deviceId: r.id as string,
    tenantId: r.tenant_id as string,
    tenantName: (pick(r.tenants) as { name: string } | null)?.name ?? '',
    vehicleId: r.vehicle_id as string,
    registration: (pick(r.vehicles) as { registration: string } | null)?.registration ?? '',
    fittedAt: r.fitted_at as string,
    imei: (pick(r.device_units) as { imei: string } | null)?.imei ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Creation from a paid invoice
// ---------------------------------------------------------------------------

export interface CreatedJobs {
  created: number;
  existing: number;
  shortfall: number;
}

/**
 * Derive and insert the jobs a PAID invoice's one-off lines call for. Safe to
 * call again: a job is keyed by (invoice, vehicle, kind) and the count per
 * kind never exceeds what the lines price, so a replay — or a retry after a
 * partial failure — only fills gaps. Not paid → nothing (money first).
 */
export async function createHardwareJobs(invoiceId: string, sb: Sb = createServiceClient(), today: string = todayISO()): Promise<CreatedJobs> {
  const { data: inv, error: invErr } = await sb.from('subscription_invoices').select('id, tenant_id, status, number').eq('id', invoiceId).maybeSingle();
  if (invErr) throw new Error(invErr.message);
  if (!inv) throw new Error('Invoice not found.');
  if (inv.status !== 'paid') return { created: 0, existing: 0, shortfall: 0 };
  const tenantId = inv.tenant_id;

  const { data: lineRows, error: lineErr } = await sb
    .from('subscription_invoice_lines')
    .select('addon_id, vehicle_id, quantity, addons(job_kind)')
    .eq('invoice_id', invoiceId)
    .not('addon_id', 'is', null);
  if (lineErr) throw new Error(lineErr.message);
  const lines = ((lineRows ?? []) as unknown as Record<string, unknown>[])
    .map((l) => ({
      addonId: l.addon_id as string,
      jobKind: ((pick(l.addons) as { job_kind: string | null } | null)?.job_kind ?? null) as JobKind | null,
      vehicleId: (l.vehicle_id as string | null) ?? null,
      quantity: Number(l.quantity),
    }))
    .filter((l) => l.jobKind);
  if (!lines.length) return { created: 0, existing: 0, shortfall: 0 };

  const [{ data: vehicles }, { data: devices }, { data: openRows }, { data: existingRows }] = await Promise.all([
    sb.from('vehicles').select('id, created_at').eq('tenant_id', tenantId),
    sb.from('telematics_devices').select('vehicle_id').eq('tenant_id', tenantId).eq('kind', 'hardware').is('removed_at', null),
    sb.from('hardware_jobs').select('vehicle_id, kind, invoice_id').eq('tenant_id', tenantId).in('status', [...OPEN_JOB_STATUSES]),
    sb.from('hardware_jobs').select('id, vehicle_id, kind, detail').eq('invoice_id', invoiceId),
  ]);
  const fitted = new Set((devices ?? []).map((d) => d.vehicle_id as string));
  const openByVehicle = new Map<string, JobKind[]>();
  for (const j of openRows ?? []) {
    // This invoice's own jobs are "already placed", not blockers — a replay must land on the same vehicles.
    if (j.invoice_id === invoiceId || !j.vehicle_id) continue;
    openByVehicle.set(j.vehicle_id, [...(openByVehicle.get(j.vehicle_id) ?? []), j.kind as JobKind]);
  }
  const forJobs: VehicleForJobs[] = (vehicles ?? []).map((v) => ({
    id: v.id,
    hasFittedDevice: fitted.has(v.id),
    openJobs: openByVehicle.get(v.id) ?? [],
    createdAt: v.created_at,
  }));
  const { jobs: derived, shortfall } = deriveJobs(lines, forJobs);

  const existing = (existingRows ?? []) as { id: string; vehicle_id: string | null; kind: string; detail: Record<string, unknown> | null }[];
  const existingKey = new Set(existing.map((e) => `${e.vehicle_id}|${e.kind}`));
  // A job raised ahead of payment (an out-of-warranty replacement) is released now.
  for (const e of existing) {
    if (e.detail && (e.detail as Record<string, unknown>).awaiting_payment) {
      await patchJob(sb, e.id, { detail: { ...e.detail, awaiting_payment: false, paid_on: today } });
      await hardwareEvent(sb, { tenantId, jobId: e.id, kind: 'paid', actor: 'system', detail: { invoice: inv.number } });
    }
  }

  const settings = await platformSettings(sb);
  const slaDays = settings['hardware.install_sla_days'];
  const due = slaDueOn(today, slaDays);
  const kinds = [...new Set(derived.map((d) => d.kind))];
  let created = 0;
  const createdIds: { id: string; vehicleId: string | null }[] = [];
  for (const kind of kinds) {
    const ofKind = derived.filter((d) => d.kind === kind);
    const already = existing.filter((e) => e.kind === kind).length;
    let allowed = Math.max(0, ofKind.length - already);
    for (const d of ofKind) {
      if (allowed <= 0) break;
      if (existingKey.has(`${d.vehicleId}|${d.kind}`)) continue;
      const { data, error } = await sb
        .from('hardware_jobs')
        .insert({
          tenant_id: tenantId,
          vehicle_id: d.vehicleId,
          kind: d.kind,
          status: 'pending',
          source: 'invoice',
          invoice_id: invoiceId,
          addon_ids: d.addonIds,
          sla_due_on: due,
          under_warranty: d.kind === 'replace' ? false : null,
          detail: { invoice: inv.number } as never,
        } as never)
        .select('id')
        .single();
      if (error) {
        // A concurrent replay won the race for this key: fine, it exists.
        if (error.code === '23505') continue;
        throw new Error(`job insert: ${error.message}`);
      }
      const id = (data as { id: string }).id;
      created += 1;
      allowed -= 1;
      createdIds.push({ id, vehicleId: d.vehicleId });
      await hardwareEvent(sb, { tenantId, jobId: id, kind: 'created', actor: 'system', detail: { source: 'invoice', invoice: inv.number, kind: d.kind, slaDueOn: due } });
    }
  }

  if (created > 0 || shortfall > 0) {
    await recordEvent(sb, tenantId, invoiceId, 'hardware_jobs_created', 'system', { created, existing: existing.length, shortfall });
  }
  if (created > 0) await tellCustomerJobsCreated(sb, tenantId, createdIds, slaDays);
  return { created, existing: existing.length, shortfall };
}

/** One SMS per phone number, listing the vehicles it covers. */
async function tellCustomerJobsCreated(sb: Sb, tenantId: string, jobs: { id: string; vehicleId: string | null }[], slaDays: number): Promise<void> {
  const brand = deploymentBrand().productName;
  const vehicleIds = jobs.map((j) => j.vehicleId).filter((v): v is string => Boolean(v));
  const { data: vehicles } = vehicleIds.length ? await sb.from('vehicles').select('id, registration').in('id', vehicleIds) : { data: [] };
  const reg = new Map((vehicles ?? []).map((v) => [v.id, v.registration]));
  const byPhone = new Map<string, { jobId: string; registrations: string[] }>();
  for (const j of jobs) {
    const phone = (await customerPhoneFor(sb, tenantId, j.vehicleId)) ?? '';
    const entry = byPhone.get(phone) ?? { jobId: j.id, registrations: [] };
    entry.registrations.push(j.vehicleId ? (reg.get(j.vehicleId) ?? '?') : '?');
    byPhone.set(phone, entry);
  }
  for (const [phone, entry] of byPhone) {
    await smsAboutJob(sb, { tenantId, jobId: entry.jobId, to: phone || null, text: jobsCreatedText(brand, entry.registrations, slaDays), subject: 'Hardware job created', audience: 'customer' });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  installerId: string;
  scheduledAt: string;
  address?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}

/** Book an installer. Snapshots the fee; texts the customer and the installer. */
export async function scheduleJob(id: string, input: ScheduleInput, actor: string, sb: Sb = createServiceClient()): Promise<void> {
  const job = await loadJob(id, sb);
  if (!['pending', 'scheduled', 'failed'].includes(job.status)) throw new Error(`A ${job.status} job cannot be scheduled.`);
  if (job.detail.awaiting_payment) throw new Error(`Invoice ${job.invoiceNumber ?? ''} must be paid before this job is scheduled.`.replace('  ', ' '));
  if (!input.scheduledAt || Number.isNaN(Date.parse(input.scheduledAt))) throw new Error('Pick a date and time.');
  const installer = await installerById(input.installerId, sb);
  if (!installer || !installer.active) throw new Error('Installer not found or inactive.');
  const fee = feeFor(installer, job.kind);
  await patchJob(sb, id, {
    status: 'scheduled',
    installer_id: installer.id,
    scheduled_at: new Date(input.scheduledAt).toISOString(),
    address: input.address?.trim() || null,
    contact_name: input.contactName?.trim() || null,
    contact_phone: input.contactPhone?.trim() || null,
    fee_minor: fee,
    failure_reason: null,
  });
  await hardwareEvent(sb, { tenantId: job.tenantId, jobId: id, kind: job.status === 'failed' ? 'rescheduled' : 'scheduled', actor, detail: { installer: installer.name, scheduledAt: input.scheduledAt, feeMinor: fee } });

  const brand = deploymentBrand().productName;
  const registration = job.vehicle?.registration ?? '';
  const customer = input.contactPhone?.trim() || (await customerPhoneFor(sb, job.tenantId, job.vehicleId));
  await smsAboutJob(sb, { tenantId: job.tenantId, jobId: id, to: customer, text: scheduledCustomerText(brand, registration, job.kind, input.scheduledAt, installer.name), subject: 'Job scheduled', audience: 'customer' });
  await smsAboutJob(sb, {
    tenantId: job.tenantId,
    jobId: id,
    to: installer.phone,
    text: scheduledInstallerText(brand, { registration, make: job.vehicle?.make ?? null, kind: job.kind, whenIso: input.scheduledAt, address: input.address ?? null, contactName: input.contactName ?? null, contactPhone: input.contactPhone ?? customer }),
    subject: 'Job assigned',
    audience: 'installer',
  });
}

export async function startJob(id: string, actor: string, sb: Sb = createServiceClient()): Promise<void> {
  const job = await loadJob(id, sb);
  if (job.status !== 'scheduled') throw new Error(`A ${job.status} job cannot be started.`);
  await patchJob(sb, id, { status: 'in_progress' });
  await hardwareEvent(sb, { tenantId: job.tenantId, jobId: id, kind: 'started', actor });
}

export interface CompleteInput {
  /** The stock unit fitted (install, replace, or a service visit that swapped the unit). */
  unitImei?: string | null;
  checklist?: Record<string, boolean>;
  photos?: JobPhoto[];
  notes?: string | null;
  /** What happened to the unit taken off the vehicle (replace / remove / swap). */
  oldUnitOutcome?: 'faulty' | 'lost' | 'returned';
  fittedAt?: string;
}

export interface CompleteResult {
  deviceId: string | null;
  unitId: string | null;
  replacedDeviceId: string | null;
}

/**
 * Close a job. For install / replace / a swap: the unit leaves stock, the old
 * active device (if any) becomes history, a fresh device row is fitted with its
 * warranty. For remove: the device becomes history and the unit comes back.
 * Every configured checklist item must be ticked; a fitted unit needs a photo.
 */
export async function completeJob(id: string, input: CompleteInput, actor: string, sb: Sb = createServiceClient()): Promise<CompleteResult> {
  const job = await loadJob(id, sb);
  if (!['pending', 'scheduled', 'in_progress'].includes(job.status)) throw new Error(`A ${job.status} job cannot be completed.`);
  if (job.detail.awaiting_payment) throw new Error('This job is waiting for its invoice to be paid.');
  if (!job.vehicleId) throw new Error('This job has no vehicle.');
  const settings = await platformSettings(sb);
  const fittedAt = input.fittedAt ?? new Date().toISOString();
  const today = fittedAt.slice(0, 10);
  const imei = input.unitImei?.trim() || null;
  const fitsUnit = job.kind === 'install' || job.kind === 'replace' || (job.kind === 'service' && Boolean(imei));
  if ((job.kind === 'install' || job.kind === 'replace') && !imei) throw new Error('Enter the IMEI of the unit fitted.');

  const checklist = input.checklist ?? {};
  if (fitsUnit) {
    const missing = settings['hardware.checklist'].filter((item) => !checklist[item]);
    if (missing.length) throw new Error(`Checklist incomplete: ${missing.join('; ')}.`);
    if (!(input.photos?.length ?? 0)) throw new Error('At least one photo of the fitted unit is required.');
  }

  const old = await getVehicleDevice(job.tenantId, job.vehicleId);
  let deviceId: string | null = null;
  let unitId: string | null = null;
  let replacedDeviceId: string | null = null;

  if (fitsUnit && imei) {
    const { data: unit } = await sb.from('device_units').select('id, state, tenant_id, model, has_immobiliser').eq('imei', imei).maybeSingle();
    if (!unit) throw new Error(`No unit with IMEI ${imei} in stock.`);
    if (!['in_stock', 'allocated'].includes(unit.state as UnitState)) throw new Error(`Unit ${imei} is ${unit.state}, not in stock.`);
    if (unit.tenant_id && unit.tenant_id !== job.tenantId) throw new Error(`Unit ${imei} is allocated to another customer.`);

    if (old) {
      replacedDeviceId = old.id;
      await removeVehicleDevice(job.tenantId, job.vehicleId, job.kind === 'install' ? 'superseded' : 'replaced');
      if (old.unit) {
        const { data: oldUnit } = await sb.from('device_units').select('id').eq('imei', old.unit.imei).maybeSingle();
        if (oldUnit) {
          const outcome = input.oldUnitOutcome ?? 'faulty';
          await moveUnit(oldUnit.id, outcome === 'lost' ? 'lose' : outcome === 'returned' ? 'return' : 'fault', actor, { jobId: id }, sb);
        }
      }
    }
    // A warranty swap continues the original cover; anything else starts fresh cover.
    const warranty = job.underWarranty && old?.warranty_until ? old.warranty_until : warrantyUntil(fittedAt, settings['hardware.warranty_months']);
    const label = `${unit.model ?? 'Tracker'} ${imei.slice(-4)}`;
    const dev = await provisionDevice(job.tenantId, job.vehicleId, 'hardware', label, { unitId: unit.id, fittedAt, installerId: job.installerId, warrantyUntil: warranty, state: 'fitted' });
    deviceId = dev.id;
    unitId = unit.id;
    const { error: unitErr } = await sb
      .from('device_units')
      .update({ state: 'fitted', tenant_id: job.tenantId, vehicle_id: job.vehicleId, updated_at: new Date().toISOString() } as never)
      .eq('id', unit.id);
    if (unitErr) throw new Error(`unit: ${unitErr.message}`);
    await hardwareEvent(sb, { tenantId: job.tenantId, jobId: id, unitId: unit.id, deviceId, kind: 'unit_fitted', actor, detail: { imei, warrantyUntil: warranty, replacedDeviceId } });
  } else if (job.kind === 'remove') {
    if (!old) throw new Error('No tracker is fitted to this vehicle.');
    replacedDeviceId = old.id;
    await removeVehicleDevice(job.tenantId, job.vehicleId, 'removed');
    if (old.unit) {
      const { data: oldUnit } = await sb.from('device_units').select('id').eq('imei', old.unit.imei).maybeSingle();
      if (oldUnit) {
        const outcome = input.oldUnitOutcome ?? 'returned';
        await moveUnit(oldUnit.id, outcome === 'lost' ? 'lose' : outcome === 'faulty' ? 'fault' : 'return', actor, { jobId: id }, sb);
        unitId = oldUnit.id;
      }
    }
  } else {
    // A service visit that fixed the unit in place.
    deviceId = old?.id ?? null;
  }

  await patchJob(sb, id, {
    status: 'done',
    completed_at: fittedAt,
    // A user id when a person closed it; the timeline keeps the actor text either way.
    completed_by: UUID_PATTERN.test(actor) ? actor : null,
    unit_id: unitId,
    device_id: deviceId,
    replaced_device_id: replacedDeviceId,
    checklist,
    photos: input.photos ?? [],
    notes: input.notes?.trim() || null,
  });
  await hardwareEvent(sb, { tenantId: job.tenantId, jobId: id, unitId, deviceId, kind: 'completed', actor, detail: { kind: job.kind, photos: input.photos?.length ?? 0 } });
  if (job.requestId) {
    await sb.from('owner_requests').update({ status: 'closed', closed_at: fittedAt, resolution: `Hardware job ${job.kind} completed.` } as never).eq('id', job.requestId).eq('status', 'acknowledged');
  }
  const brand = deploymentBrand().productName;
  await smsAboutJob(sb, { tenantId: job.tenantId, jobId: id, to: await customerPhoneFor(sb, job.tenantId, job.vehicleId), text: completedCustomerText(brand, job.vehicle?.registration ?? '', job.kind), subject: 'Job completed', audience: 'customer' });
  return { deviceId, unitId, replacedDeviceId };
}

export async function failJob(id: string, reason: string, actor: string, sb: Sb = createServiceClient()): Promise<void> {
  const job = await loadJob(id, sb);
  if (!['scheduled', 'in_progress'].includes(job.status)) throw new Error(`A ${job.status} job cannot fail.`);
  if (!reason.trim()) throw new Error('Say why the visit failed.');
  await patchJob(sb, id, { status: 'failed', failure_reason: reason.trim() });
  await hardwareEvent(sb, { tenantId: job.tenantId, jobId: id, kind: 'failed', actor, detail: { reason: reason.trim() } });
}

export async function cancelJob(id: string, reason: string, actor: string, sb: Sb = createServiceClient()): Promise<void> {
  const job = await loadJob(id, sb);
  if (!['pending', 'scheduled', 'failed'].includes(job.status)) throw new Error(`A ${job.status} job cannot be cancelled.`);
  await patchJob(sb, id, { status: 'cancelled', cancelled_at: new Date().toISOString(), failure_reason: reason.trim() || null });
  await hardwareEvent(sb, { tenantId: job.tenantId, jobId: id, kind: 'cancelled', actor, detail: { reason: reason.trim() || null } });
}

// ---------------------------------------------------------------------------
// Faults and replacements
// ---------------------------------------------------------------------------

/**
 * A fault on a fitted tracker (owner report, alarm, or ops) opens ONE service
 * job per vehicle; warranty is decided now from the fitted device's cover.
 */
export async function createFaultJob(
  tenantId: string,
  vehicleId: string,
  source: 'fault' | 'alarm' | 'manual',
  detail: Record<string, unknown>,
  opts: { requestId?: string | null; actor: string; today?: string; sb?: Sb },
): Promise<{ id: string; created: boolean }> {
  const sb = opts.sb ?? createServiceClient();
  const today = opts.today ?? todayISO();
  const { data: open } = await sb
    .from('hardware_jobs')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId)
    .in('status', [...OPEN_JOB_STATUSES])
    .in('source', ['fault', 'alarm', 'manual'])
    .limit(1)
    .maybeSingle();
  if (open) return { id: open.id, created: false };
  const device = await getVehicleDevice(tenantId, vehicleId);
  if (!device || device.kind !== 'hardware') throw new Error('No tracker is fitted to this vehicle.');
  const settings = await platformSettings(sb);
  const covered = underWarranty(device.fitted_at, settings['hardware.warranty_months'], today);
  const { data, error } = await sb
    .from('hardware_jobs')
    .insert({
      tenant_id: tenantId,
      vehicle_id: vehicleId,
      kind: 'service',
      status: 'pending',
      source,
      request_id: opts.requestId ?? null,
      device_id: device.id,
      under_warranty: covered,
      sla_due_on: slaDueOn(today, settings['hardware.install_sla_days']),
      detail: detail as never,
    } as never)
    .select('id')
    .single();
  if (error) throw new Error(`fault job: ${error.message}`);
  const id = (data as { id: string }).id;
  await hardwareEvent(sb, { tenantId, jobId: id, deviceId: device.id, kind: 'created', actor: opts.actor, detail: { source, underWarranty: covered, ...detail } });
  return { id, created: true };
}

/**
 * A job raised by hand from the console (a goodwill visit, a removal at the
 * end of a subscription, an install for a vehicle added without a priced
 * line). Install needs no device on the vehicle; the rest need one.
 */
export async function createManualJob(
  tenantId: string,
  vehicleId: string,
  kind: JobKind,
  note: string | null,
  actor: string,
  sb: Sb = createServiceClient(),
  today: string = todayISO(),
): Promise<{ id: string }> {
  const { data: v } = await sb.from('vehicles').select('id').eq('tenant_id', tenantId).eq('id', vehicleId).maybeSingle();
  if (!v) throw new Error('Vehicle not found for this subscriber.');
  const device = await getVehicleDevice(tenantId, vehicleId);
  const hasHardware = Boolean(device && device.kind === 'hardware');
  if (kind === 'install' && hasHardware) throw new Error('This vehicle already has a tracker fitted — raise a replacement or service job instead.');
  if (kind !== 'install' && !hasHardware) throw new Error('No tracker is fitted to this vehicle.');
  const { data: open } = await sb.from('hardware_jobs').select('id').eq('tenant_id', tenantId).eq('vehicle_id', vehicleId).eq('kind', kind).in('status', [...OPEN_JOB_STATUSES]).limit(1).maybeSingle();
  if (open) throw new Error(`There is already an open ${kind} job for this vehicle.`);
  const settings = await platformSettings(sb);
  const { data, error } = await sb
    .from('hardware_jobs')
    .insert({
      tenant_id: tenantId,
      vehicle_id: vehicleId,
      kind,
      status: 'pending',
      source: 'manual',
      device_id: kind === 'install' ? null : (device?.id ?? null),
      under_warranty: kind === 'install' ? null : underWarranty(device?.fitted_at ?? null, settings['hardware.warranty_months'], today),
      sla_due_on: slaDueOn(today, settings['hardware.install_sla_days']),
      notes: note?.trim() || null,
      detail: { note: note?.trim() || null } as never,
    } as never)
    .select('id')
    .single();
  if (error) throw new Error(`job: ${error.message}`);
  const id = (data as { id: string }).id;
  await hardwareEvent(sb, { tenantId, jobId: id, deviceId: kind === 'install' ? null : (device?.id ?? null), kind: 'created', actor, detail: { source: 'manual', kind } });
  return { id };
}

/**
 * Out of warranty: the customer pays for the replacement before anyone is
 * dispatched. Issues a one-off invoice with the catalogue's replacement item
 * for this vehicle and parks the job until `createHardwareJobs` sees it paid.
 */
export async function raiseReplacementInvoice(jobId: string, actor: string, sb: Sb = createServiceClient(), today: string = todayISO()): Promise<{ invoiceId: string; number: string }> {
  const job = await loadJob(jobId, sb);
  if (!OPEN_JOB_STATUSES.includes(job.status)) throw new Error(`A ${job.status} job cannot be invoiced.`);
  if (job.underWarranty) throw new Error('This device is under warranty — no charge.');
  if (!job.vehicleId) throw new Error('This job has no vehicle.');
  if (job.invoiceId && job.detail.awaiting_payment) {
    const existing = await invoiceById(job.tenantId, job.invoiceId, sb);
    if (existing && existing.status !== 'void') return { invoiceId: existing.id, number: existing.number };
  }
  const region = regionProvider().id;
  const { data: items } = await sb.from('addons').select('id, key, region, unit_price_pence').eq('active', true).eq('kind', 'one_off').eq('job_kind', 'replace').order('key');
  const candidates = (items ?? []).filter((i) => i.region === region || i.region === null).sort((a, b) => Number(b.region === region) - Number(a.region === region));
  if (!candidates.length) throw new Error('No replacement item in the catalogue for this region. Add one under Catalogue with job kind "replace".');
  const item = candidates.find((i) => Number(i.unit_price_pence) > 0);
  if (!item) throw new Error(`The replacement item (${candidates[0].key}) has no price yet. Price it under Catalogue first.`);
  const draft = await buildOneOffDraft([{ addonId: item.id, quantity: 1, vehicleId: job.vehicleId }], job.tenantId, sb);
  const issued = await issueInvoice({
    tenantId: job.tenantId,
    kind: 'one_off',
    lines: draft.lines,
    dueOn: today,
    currency: draft.currency,
    vatRate: draft.vatRate,
    actor,
    note: `Tracker replacement for ${job.vehicle?.registration ?? 'vehicle'} (out of warranty).`,
    sb,
    today,
  });
  await patchJob(sb, jobId, { invoice_id: issued.id, kind: 'replace', addon_ids: [item.id], detail: { ...job.detail, awaiting_payment: true, invoice: issued.number } });
  await hardwareEvent(sb, { tenantId: job.tenantId, jobId, kind: 'invoice_raised', actor, detail: { invoice: issued.number, grossMinor: issued.grossMinor } });
  const row = await invoiceById(job.tenantId, issued.id, sb);
  if (row) await notifyInvoiceIssued(row, { sb }).catch((e: unknown) => console.error('[hardware] invoice notify failed', issued.number, e));
  return { invoiceId: issued.id, number: issued.number };
}
