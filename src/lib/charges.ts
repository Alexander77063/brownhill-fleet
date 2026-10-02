/**
 * Charges — driver-submitted charges/receipts and the ops-facing charge list.
 *
 * A driver submits a photo against a tenant-defined, driver-submittable category.
 * A **charge**-kind category becomes a `charges` row (type 'other') at status
 * 'received' with a 48h report window; an **expense**-kind category becomes an
 * `expenses` row. Either way the tenant owner is notified for review. Tenant and
 * driver ids are resolved on the server from the session — never trusted from the
 * client — mirroring the `disputeCharge` service-role write pattern.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { notifyTenantOwner } from '@/lib/comms';
import { recordExpense } from '@/lib/expenses';

type Sb = ReturnType<typeof createServiceClient>;

async function audit(
  sb: Sb,
  tenantId: string,
  action: string,
  entityId: string,
  detail: Record<string, unknown>,
  actor?: string | null,
) {
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: action,
    p_entity_type: 'charge',
    p_entity_id: entityId,
    p_detail: detail as never,
    p_actor: actor ?? undefined,
  });
}

/** Vehicles a driver is (or was) assigned to, via their agreements — for the
 *  submission picker and server-side validation. */
export async function listDriverVehicles(driverId: string): Promise<{ id: string; registration: string }[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('agreements')
    .select('vehicle_id, vehicles(registration)')
    .eq('driver_id', driverId);
  const seen = new Map<string, string>();
  for (const r of (data ?? []) as { vehicle_id: string; vehicles: { registration: string } | null }[]) {
    if (r.vehicle_id && !seen.has(r.vehicle_id)) seen.set(r.vehicle_id, r.vehicles?.registration ?? r.vehicle_id);
  }
  return [...seen.entries()].map(([id, registration]) => ({ id, registration }));
}

export interface DriverSubmittableCategory {
  id: string;
  name: string;
  kind: 'expense' | 'charge';
}

/** The driver-submittable categories for a driver's tenant. */
export async function listDriverSubmittableCategories(driverId: string): Promise<DriverSubmittableCategory[]> {
  const sb = createServiceClient();
  const { data: drv } = await sb.from('drivers').select('tenant_id').eq('id', driverId).maybeSingle();
  if (!drv) return [];
  const { data } = await sb
    .from('expense_categories')
    .select('id, name, kind')
    .eq('tenant_id', (drv as { tenant_id: string }).tenant_id)
    .eq('driver_submittable', true)
    .eq('is_active', true)
    .order('kind')
    .order('name');
  return (data ?? []) as DriverSubmittableCategory[];
}

export interface SubmitDriverReceiptInput {
  categoryId: string;
  vehicleId?: string | null;
  amountPence: number;
  reference?: string | null;
  incidentOn?: string | null;
  docPath?: string | null;
}

export interface SubmitDriverReceiptResult {
  kind: 'expense' | 'charge';
  id: string;
}

/**
 * Create a charge or expense from a driver submission. Resolves the driver's
 * tenant, validates the chosen category (must be driver-submittable in that
 * tenant), and — for charges — that the vehicle is one of the driver's own.
 */
export async function submitDriverReceipt(
  driverId: string,
  input: SubmitDriverReceiptInput,
): Promise<SubmitDriverReceiptResult> {
  if (!(input.amountPence >= 0)) throw new Error('Amount cannot be negative.');
  const sb = createServiceClient();

  const { data: drv } = await sb.from('drivers').select('tenant_id').eq('id', driverId).maybeSingle();
  if (!drv) throw new Error('No active driver account.');
  const tenantId = (drv as { tenant_id: string }).tenant_id;

  // The driver's login user (profiles.id), for attribution — null if they have no
  // account yet (created_by / audit actor must be a real profile or null).
  const { data: prof } = await sb.from('profiles').select('id').eq('driver_id', driverId).maybeSingle();
  const actorUserId = (prof as { id: string } | null)?.id ?? null;

  const { data: cat } = await sb
    .from('expense_categories')
    .select('id, name, kind')
    .eq('id', input.categoryId)
    .eq('tenant_id', tenantId)
    .eq('driver_submittable', true)
    .eq('is_active', true)
    .maybeSingle();
  if (!cat) throw new Error('That category can no longer be used for submissions.');
  const category = cat as { id: string; name: string; kind: 'expense' | 'charge' };

  // Vehicle, if given, must be one of the driver's own. Required for charges
  // (charges.vehicle_id is NOT NULL); optional for expenses.
  let vehicleReg: string | null = null;
  if (input.vehicleId) {
    const vehicle = (await listDriverVehicles(driverId)).find((v) => v.id === input.vehicleId);
    if (!vehicle) throw new Error('Please choose one of your assigned vehicles.');
    vehicleReg = vehicle.registration;
  }

  if (category.kind === 'expense') {
    const { reference, id } = await recordExpense(
      tenantId,
      {
        categoryId: category.id,
        amountPence: input.amountPence,
        vehicleId: input.vehicleId ?? null,
        driverId,
        description: input.reference ?? undefined,
        docPath: input.docPath ?? null,
      },
      actorUserId,
    );
    await notifyTenantOwner(
      tenantId,
      `New ${category.name} expense submitted`,
      `${vehicleReg ? vehicleReg + ': ' : ''}a driver submitted a ${category.name} expense of £${(input.amountPence / 100).toFixed(2)} (ref ${reference}).`,
      { entityType: 'expense', entityId: id },
    );
    return { kind: 'expense', id: reference };
  }

  // charge-kind
  if (!input.vehicleId) throw new Error('A vehicle is required for this charge.');
  const receivedOn = new Date().toISOString().slice(0, 10);
  const reportDueAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const { data: charge, error } = await sb
    .from('charges')
    .insert({
      tenant_id: tenantId,
      vehicle_id: input.vehicleId,
      driver_id: driverId,
      category_id: category.id,
      type: 'other',
      authority: category.name,
      reference: input.reference ?? null,
      incident_on: input.incidentOn ?? null,
      received_on: receivedOn,
      report_due_at: reportDueAt,
      amount_pence: input.amountPence,
      status: 'received',
      submitted_by_driver: true,
      doc_path: input.docPath ?? null,
    } as never)
    .select('id')
    .single();
  if (error || !charge) throw new Error(`Could not submit charge: ${error?.message ?? 'none'}`);
  const chargeId = (charge as { id: string }).id;

  await audit(sb, tenantId, 'charge.driver_submitted', chargeId, {
    category: category.name,
    amount_pence: input.amountPence,
    vehicle: vehicleReg,
  }, actorUserId);

  await notifyTenantOwner(
    tenantId,
    `New ${category.name} charge submitted`,
    `${vehicleReg}: a driver submitted a ${category.name} charge of £${(input.amountPence / 100).toFixed(2)} awaiting review.`,
    { entityType: 'charge', entityId: chargeId, dedupeKey: `charge_submitted:${chargeId}` },
  );
  return { kind: 'charge', id: chargeId };
}

export interface OpsChargeRow {
  id: string;
  type: string;
  authority: string | null;
  reference: string | null;
  received_on: string;
  amount_pence: number;
  report_due_at: string | null;
  status: string;
  vehicle_reg: string | null;
  category: string | null;
  has_receipt: boolean;
  submitted_by_driver: boolean;
}

/** Tenant's charges enriched with vehicle registration, category name and whether
 *  a receipt is attached — for the ops charges list. */
export async function listOpsCharges(tenantId: string, limit = 200): Promise<OpsChargeRow[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('charges')
    .select(
      'id, type, authority, reference, received_on, amount_pence, report_due_at, status, category_id, doc_path, submitted_by_driver, vehicles(registration)',
    )
    .eq('tenant_id', tenantId)
    .order('received_on', { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as {
    id: string;
    type: string;
    authority: string | null;
    reference: string | null;
    received_on: string;
    amount_pence: number;
    report_due_at: string | null;
    status: string;
    category_id: string | null;
    doc_path: string | null;
    submitted_by_driver: boolean | null;
    vehicles: { registration: string } | null;
  }[];

  const catIds = [...new Set(rows.map((r) => r.category_id).filter(Boolean) as string[])];
  const catName = new Map<string, string>();
  if (catIds.length) {
    const { data: cats } = await sb.from('expense_categories').select('id, name').in('id', catIds);
    for (const c of (cats ?? []) as { id: string; name: string }[]) catName.set(c.id, c.name);
  }

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    authority: r.authority,
    reference: r.reference,
    received_on: r.received_on,
    amount_pence: r.amount_pence,
    report_due_at: r.report_due_at,
    status: r.status,
    vehicle_reg: r.vehicles?.registration ?? null,
    category: r.category_id ? (catName.get(r.category_id) ?? null) : null,
    has_receipt: !!r.doc_path,
    submitted_by_driver: !!r.submitted_by_driver,
  }));
}
