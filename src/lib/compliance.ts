/**
 * Compliance — the document/expiry engine behind the compliance cockpit. Pure
 * grading is testable in isolation; the sync builds the unified `obligations`
 * surface from source data, and the blocking helpers stop a non-compliant vehicle
 * or driver being put on the road.
 */

import { daysBetween } from '@/lib/cron';
import { planVehicleCompliance, type ComplianceRecord } from '@/lib/compliance-plan';
import { documentLabel, listExpiringDocuments, plannableDriverSpecs } from '@/lib/driver-documents';
import { planDriverCompliance } from '@/lib/compliance-plan';
import { regionProvider } from '@/lib/region';
import { createServiceClient } from '@/lib/supabase/server';

export type ObStatus = 'open' | 'due_soon' | 'overdue';
export type Severity = 'info' | 'warning' | 'critical';
export type Rag = 'green' | 'amber' | 'red';

/** Grade a due date into status + severity. Overdue → red/critical; ≤7d → critical;
 * ≤30d → amber/warning; else green/info. */
export function gradeObligation(todayISO: string, dueISO: string): { status: ObStatus; severity: Severity } {
  const days = daysBetween(todayISO, dueISO);
  if (days < 0) return { status: 'overdue', severity: 'critical' };
  const severity: Severity = days <= 7 ? 'critical' : days <= 30 ? 'warning' : 'info';
  return { status: days <= 30 ? 'due_soon' : 'open', severity };
}

export function ragOf(status: ObStatus | string, severity: Severity | string): Rag {
  if (status === 'overdue' || severity === 'critical') return 'red';
  if (status === 'due_soon' || severity === 'warning') return 'amber';
  return 'green';
}

// The document types that make a vehicle/driver roadworthy. An overdue one blocks
// assignment.
// `vehicle_compliance_expiry` carries whatever the ACTIVE REGION marks mandatory
// — a certificate of roadworthiness or vehicle licence in Nigeria, a PHV licence
// in the UK. Documents the region marks optional land on
// `vehicle_document_expiry`, which is deliberately absent here: a lapsed hackney
// permit should be visible without grounding a working vehicle.
export const BLOCKING_TYPES = [
  'mot',
  'ved_renewal',
  'insurance_expiry',
  'pco_licence_expiry',
  'dvla_check',
  'vehicle_compliance_expiry',
  // Mandatory driver documents in the active region — an FRSC licence in
  // Nigeria, a PCO licence in the UK. Optional ones use the advisory type
  // driver_document_expiry, which is deliberately not listed here.
  'driver_compliance_expiry',
] as const;

interface ObligationRow {
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  type: string;
  title: string;
  due_date: string;
  status: ObStatus;
  severity: Severity;
}

/**
 * Rebuild the obligations surface from source data. Upserts on
 * (entity_type, entity_id, type). Adds DVLA re-check (every 6 months) to the
 * existing MOT/VED/insurance/PCO coverage. Returns how many were written.
 */
export async function syncComplianceObligations(tenantId: string, today: string): Promise<number> {
  const sb = createServiceClient();
  const within = (d: string | null, horizon = 30) => d != null && daysBetween(today, d) <= horizon;
  const rows: ObligationRow[] = [];
  const push = (r: Omit<ObligationRow, 'tenant_id' | 'status' | 'severity'>) =>
    rows.push({ tenant_id: tenantId, ...r, ...gradeObligation(today, r.due_date) });

  const { data: certs } = await sb
    .from('insurance_certificates')
    .select('driver_id, insurer, cover_to')
    .eq('tenant_id', tenantId)
    .neq('status', 'rejected');
  for (const c of (certs ?? []) as { driver_id: string; insurer: string; cover_to: string }[]) {
    if (within(c.cover_to)) {
      push({ entity_type: 'driver', entity_id: c.driver_id, type: 'insurance_expiry', title: `Insurance cover (${c.insurer}) expires ${c.cover_to}`, due_date: c.cover_to });
    }
  }

  const recheck = regionProvider().driverLicenceRecheck;
  const { data: drivers } = await sb.from('drivers').select('id, full_name, pco_licence_expiry, dvla_checked_on').eq('tenant_id', tenantId);
  for (const d of (drivers ?? []) as { id: string; full_name: string; pco_licence_expiry: string | null; dvla_checked_on: string | null }[]) {
    if (within(d.pco_licence_expiry)) {
      push({ entity_type: 'driver', entity_id: d.id, type: 'pco_licence_expiry', title: `PCO licence for ${d.full_name} expires ${d.pco_licence_expiry}`, due_date: d.pco_licence_expiry as string });
    }
    // A national licence re-check, where the country has one. Gated on the
    // region pack because "never checked" means due now: on a build for a
    // country with no such service, every driver would be raised as overdue the
    // moment they were added, and this type blocks dispatch — the entire
    // workforce would be undispatchable on day one.
    if (recheck) {
      const dueOn = d.dvla_checked_on ? addDays(d.dvla_checked_on, recheck.intervalDays) : today;
      if (within(dueOn)) {
        push({ entity_type: 'driver', entity_id: d.id, type: 'dvla_check', title: `${recheck.label} for ${d.full_name} due ${dueOn}`, due_date: dueOn });
      }
    }
  }

  // Uploaded driver documents with an expiry, graded by the active region.
  //
  // What each country requires of a driver — and whether driving without it is
  // illegal — is the region pack's business, so `planDriverCompliance` decides
  // which of the two types each document raises: mandatory ones block dispatch,
  // optional ones are visible without grounding anyone.
  //
  // Column-backed documents are skipped by the planner, not by a name check
  // here. A PCO licence writes through to `drivers.pco_licence_expiry`, which
  // the loop above already turns into its own blocking obligation; raising a
  // second one from the document row would mean two dates for one licence.
  const documents = await listExpiringDocuments(tenantId);
  const driverNames = new Map((drivers ?? []).map((d) => [d.id, d.full_name] as const));
  const driverDocSpecs = plannableDriverSpecs();

  const byDriver = new Map<string, typeof documents>();
  for (const doc of documents) {
    const list = byDriver.get(doc.driver_id) ?? [];
    list.push(doc);
    byDriver.set(doc.driver_id, list);
  }

  for (const [driverId, docs] of byDriver) {
    const planned = planDriverCompliance(
      driverDocSpecs,
      docs.map((d) => ({ obligation_key: d.kind, expires_on: d.expires_on, reference: null })),
      today,
    );
    for (const ob of planned) {
      // An "other" document's typed label is more use than the generic one.
      const source = docs.find((d) => d.kind === ob.obligationKey && d.expires_on === ob.dueDate);
      const label = source?.title?.trim() || ob.label || 'Document';
      push({
        entity_type: 'driver',
        entity_id: driverId,
        type: ob.type,
        title: `${label} for ${driverNames.get(driverId) ?? 'driver'} expires ${ob.dueDate}`,
        due_date: ob.dueDate,
      });
    }
  }

  const { data: vehicles } = await sb.from('vehicles').select('id, registration, mot_due_on, ved_renewal_on').eq('tenant_id', tenantId);
  for (const v of (vehicles ?? []) as { id: string; registration: string; mot_due_on: string | null; ved_renewal_on: string | null }[]) {
    if (within(v.mot_due_on)) push({ entity_type: 'vehicle', entity_id: v.id, type: 'mot', title: `MOT for ${v.registration} due ${v.mot_due_on}`, due_date: v.mot_due_on as string });
    if (within(v.ved_renewal_on)) push({ entity_type: 'vehicle', entity_id: v.id, type: 'ved_renewal', title: `VED renewal for ${v.registration} due ${v.ved_renewal_on}`, due_date: v.ved_renewal_on as string });
  }

  // Region-driven vehicle compliance (migration 0055).
  //
  // MOT and road tax above are United Kingdom columns. Nigeria requires a
  // certificate of roadworthiness, an annual vehicle licence and a hackney
  // permit instead, and a third country will want something else again — so
  // those live as rows keyed by the region pack rather than as columns, and
  // `planVehicleCompliance` decides what each one raises.
  const specs = regionProvider().vehicleCompliance;
  const { data: complianceRows } = await sb
    .from('vehicle_compliance')
    .select('vehicle_id, obligation_key, expires_on, reference')
    .eq('tenant_id', tenantId);

  const byVehicle = new Map<string, ComplianceRecord[]>();
  for (const row of (complianceRows ?? []) as (ComplianceRecord & { vehicle_id: string })[]) {
    const list = byVehicle.get(row.vehicle_id);
    if (list) list.push(row);
    else byVehicle.set(row.vehicle_id, [row]);
  }

  const registrations = new Map(
    ((vehicles ?? []) as { id: string; registration: string }[]).map((v) => [v.id, v.registration] as const),
  );

  for (const [vehicleId, records] of byVehicle) {
    for (const planned of planVehicleCompliance(specs, records, today)) {
      push({
        entity_type: 'vehicle',
        entity_id: vehicleId,
        type: planned.type,
        title: `${planned.label} for ${registrations.get(vehicleId) ?? 'vehicle'} expires ${planned.dueDate}`,
        due_date: planned.dueDate,
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await sb.from('obligations').upsert(rows as never, { onConflict: 'entity_type,entity_id,type' });
    if (error) throw new Error(`obligations upsert: ${error.message}`);
  }
  return rows.length;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── TfL weekly upload (before 12:00 each Monday) ─────────────────────────────

/** The Monday (YYYY-MM-DD) of the week containing `iso`. */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const delta = dow === 0 ? -6 : 1 - dow; // back to Monday
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export interface TflStatus {
  period: string; // this week's Monday
  deadline: string; // ISO datetime: Monday 12:00
  uploaded: boolean;
  uploadedAt: string | null;
}

export async function getTflStatus(tenantId: string, todayISO: string): Promise<TflStatus> {
  const period = mondayOf(todayISO);
  const sb = createServiceClient();
  const { data } = await sb
    .from('tfl_uploads')
    .select('uploaded_at')
    .eq('tenant_id', tenantId)
    .eq('period', period)
    .maybeSingle();
  return {
    period,
    deadline: `${period}T12:00:00`,
    uploaded: !!data,
    uploadedAt: data?.uploaded_at ?? null,
  };
}

export async function markTflUploaded(tenantId: string, todayISO: string, userId: string): Promise<void> {
  const period = mondayOf(todayISO);
  const sb = createServiceClient();
  const { error } = await sb
    .from('tfl_uploads')
    .upsert({ tenant_id: tenantId, period, uploaded_by: userId, uploaded_at: new Date().toISOString() } as never, {
      onConflict: 'tenant_id,period',
    });
  if (error) throw new Error(`Could not record TfL upload: ${error.message}`);
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'tfl.uploaded',
    p_entity_type: 'tfl_upload',
    p_detail: { period } as never,
    p_actor: userId,
  });
}

export interface Blocker {
  type: string;
  title: string;
  due_date: string;
}

/**
 * Is this vehicle/driver clear to be put on the road? Non-compliant if it has any
 * OVERDUE blocking obligation (expired MOT/insurance/PCO/DVLA/VED). Returns the
 * blockers so the UI can explain why.
 */
export async function checkCompliance(entityType: 'vehicle' | 'driver', entityId: string): Promise<{ compliant: boolean; blockers: Blocker[] }> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('obligations')
    .select('type, title, due_date, status')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('status', 'overdue')
    .in('type', [...BLOCKING_TYPES]);
  const blockers = ((data ?? []) as { type: string; title: string; due_date: string }[]).map((o) => ({
    type: o.type,
    title: o.title,
    due_date: o.due_date,
  }));
  return { compliant: blockers.length === 0, blockers };
}

/** Count vehicles/drivers currently blocked from assignment (overdue blocking docs). */
export async function getBlockedEntities(tenantId: string): Promise<{ vehicles: number; drivers: number }> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('obligations')
    .select('entity_type, entity_id')
    .eq('tenant_id', tenantId)
    .eq('status', 'overdue')
    .in('type', [...BLOCKING_TYPES]);
  const v = new Set<string>();
  const d = new Set<string>();
  for (const o of (data ?? []) as { entity_type: string; entity_id: string }[]) {
    if (o.entity_type === 'vehicle') v.add(o.entity_id);
    else if (o.entity_type === 'driver') d.add(o.entity_id);
  }
  return { vehicles: v.size, drivers: d.size };
}
