/**
 * Expenses — categorised business costs with generated references (EXP-YYYY-…).
 * Tenant-scoped, audited, and numbered through the shared services. Categories are
 * tenant-configurable so each operator books costs the way they run their books.
 */

import { createServiceClient } from '@/lib/supabase/server';

type Sb = ReturnType<typeof createServiceClient>;

async function audit(sb: Sb, tenantId: string, action: string, entityId: string | null, detail: Record<string, unknown>, actor?: string | null) {
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: action,
    p_entity_type: 'expense',
    p_entity_id: entityId ?? undefined,
    p_detail: detail as never,
    p_actor: actor ?? undefined,
  });
}

export type CategoryKind = 'expense' | 'charge';
export type VatTreatment = 'standard' | 'zero' | 'exempt' | 'outside';
export const VAT_TREATMENTS: VatTreatment[] = ['standard', 'zero', 'exempt', 'outside'];

/**
 * Sensible starter categories every new tenant gets (they can rename, add, or
 * deactivate freely). Kept in sync with the same list seeded for existing
 * tenants in migration 0038_charge_receipts.sql.
 */
export const DEFAULT_CATEGORIES: { name: string; kind: CategoryKind; driverSubmittable: boolean }[] = [
  { name: 'Fuel / Petrol', kind: 'expense', driverSubmittable: true },
  { name: 'Toll', kind: 'charge', driverSubmittable: true },
  { name: 'Congestion Charge', kind: 'charge', driverSubmittable: true },
  { name: 'ULEZ', kind: 'charge', driverSubmittable: true },
  { name: 'Airport Drop-off', kind: 'charge', driverSubmittable: true },
  { name: 'PCN / Penalty', kind: 'charge', driverSubmittable: true },
  { name: 'Parking', kind: 'expense', driverSubmittable: true },
];

/**
 * Seed the default categories for a freshly-created tenant. Idempotent via the
 * unique(tenant_id, name) constraint; best-effort so tenant creation never fails
 * on it. Accepts an existing service client so it can share the caller's.
 */
export async function seedDefaultCategories(tenantId: string, sb: Sb = createServiceClient()): Promise<void> {
  await sb.from('expense_categories').upsert(
    DEFAULT_CATEGORIES.map((c) => ({
      tenant_id: tenantId,
      name: c.name,
      kind: c.kind,
      driver_submittable: c.driverSubmittable,
    })) as never,
    { onConflict: 'tenant_id,name', ignoreDuplicates: true },
  );
}

export interface Category {
  id: string;
  name: string;
  is_active: boolean;
  kind: CategoryKind;
  driver_submittable: boolean;
  vat_treatment: VatTreatment;
}

export interface ListCategoriesOptions {
  includeInactive?: boolean;
  kind?: CategoryKind;
  driverSubmittableOnly?: boolean;
}

export async function listCategories(tenantId: string, opts: ListCategoriesOptions = {}): Promise<Category[]> {
  const sb = createServiceClient();
  let q = sb
    .from('expense_categories')
    .select('id, name, is_active, kind, driver_submittable, vat_treatment')
    .eq('tenant_id', tenantId)
    .order('name');
  if (!opts.includeInactive) q = q.eq('is_active', true);
  if (opts.kind) q = q.eq('kind', opts.kind);
  if (opts.driverSubmittableOnly) q = q.eq('driver_submittable', true);
  const { data } = await q;
  return (data ?? []) as Category[];
}

export interface CreateCategoryInput {
  kind?: CategoryKind;
  driverSubmittable?: boolean;
  vatTreatment?: VatTreatment;
}

export async function createCategory(
  tenantId: string,
  name: string,
  actor: string,
  input: CreateCategoryInput = {},
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Please enter a category name.');
  const kind: CategoryKind = input.kind === 'charge' ? 'charge' : 'expense';
  const vatTreatment: VatTreatment = VAT_TREATMENTS.includes(input.vatTreatment as VatTreatment)
    ? (input.vatTreatment as VatTreatment)
    : 'standard';
  const sb = createServiceClient();
  const { error } = await sb.from('expense_categories').insert({
    tenant_id: tenantId,
    name: trimmed,
    kind,
    driver_submittable: input.driverSubmittable ?? false,
    vat_treatment: vatTreatment,
  } as never);
  if (error) {
    if (error.code === '23505') throw new Error(`The category "${trimmed}" already exists.`);
    throw new Error(`Could not create category: ${error.message}`);
  }
  await audit(sb, tenantId, 'expense.category_created', null, { name: trimmed, kind, vat_treatment: vatTreatment }, actor);
}

export async function setCategoryVatTreatment(
  tenantId: string,
  categoryId: string,
  treatment: VatTreatment,
  actor: string,
): Promise<void> {
  if (!VAT_TREATMENTS.includes(treatment)) throw new Error('Unknown VAT treatment.');
  const sb = createServiceClient();
  const { error } = await sb
    .from('expense_categories')
    .update({ vat_treatment: treatment } as never)
    .eq('id', categoryId)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`Could not update category: ${error.message}`);
  await audit(sb, tenantId, 'expense.category_updated', categoryId, { vat_treatment: treatment }, actor);
}

export async function setCategoryDriverSubmittable(
  tenantId: string,
  categoryId: string,
  submittable: boolean,
  actor: string,
): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb
    .from('expense_categories')
    .update({ driver_submittable: submittable } as never)
    .eq('id', categoryId)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`Could not update category: ${error.message}`);
  await audit(sb, tenantId, 'expense.category_updated', categoryId, { driver_submittable: submittable }, actor);
}

export async function setCategoryActive(tenantId: string, categoryId: string, active: boolean, actor: string): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb
    .from('expense_categories')
    .update({ is_active: active } as never)
    .eq('id', categoryId)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`Could not update category: ${error.message}`);
  await audit(sb, tenantId, 'expense.category_updated', null, { categoryId, active }, actor);
}

export interface RecordExpenseInput {
  categoryId?: string | null;
  amountPence: number;
  incurredOn?: string;
  description?: string;
  vehicleId?: string | null;
  driverId?: string | null;
  /** Storage path of an uploaded receipt image, in the `receipts` bucket. */
  docPath?: string | null;
}

/** Record an expense, allocating an EXP reference. Returns the reference.
 *  `actor` is a profiles.id (the recorder) or null when there is no user to
 *  attribute it to (e.g. a driver submission where the driver has no login). */
export async function recordExpense(tenantId: string, input: RecordExpenseInput, actor: string | null): Promise<{ reference: string; id: string }> {
  if (!(input.amountPence > 0)) throw new Error('Amount must be greater than zero.');
  const sb = createServiceClient();

  // Category, if given, must belong to this tenant.
  if (input.categoryId) {
    const { data: cat } = await sb.from('expense_categories').select('id').eq('id', input.categoryId).eq('tenant_id', tenantId).maybeSingle();
    if (!cat) throw new Error('Unknown expense category.');
  }

  const { data: refData, error: refErr } = await sb.rpc('next_ref', { p_tenant: tenantId, p_kind: 'EXP' });
  if (refErr || !refData) throw new Error(`Could not allocate reference: ${refErr?.message ?? 'none'}`);
  const reference = refData;

  const { data: expense, error } = await sb
    .from('expenses')
    .insert({
      tenant_id: tenantId,
      reference,
      category_id: input.categoryId ?? null,
      vehicle_id: input.vehicleId ?? null,
      driver_id: input.driverId ?? null,
      amount_pence: input.amountPence,
      incurred_on: input.incurredOn ?? undefined,
      description: input.description ?? null,
      doc_path: input.docPath ?? null,
      created_by: actor ?? null,
    } as never)
    .select('id')
    .single();
  if (error || !expense) throw new Error(`Could not record expense: ${error?.message ?? 'none'}`);

  const id = (expense as { id: string }).id;
  await audit(sb, tenantId, 'expense.recorded', id, { reference, amount_pence: input.amountPence }, actor);
  return { reference, id };
}

export interface ExpenseRow {
  id: string;
  reference: string;
  category: string | null;
  amount_pence: number;
  incurred_on: string;
  description: string | null;
  has_receipt: boolean;
}

export async function listExpenses(tenantId: string, limit = 100): Promise<ExpenseRow[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('expenses')
    .select('id, reference, amount_pence, incurred_on, description, category_id, doc_path')
    .eq('tenant_id', tenantId)
    .order('incurred_on', { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as { id: string; reference: string; amount_pence: number; incurred_on: string; description: string | null; category_id: string | null; doc_path: string | null }[];
  const cats = await listCategories(tenantId, { includeInactive: true });
  const byId = new Map(cats.map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    category: r.category_id ? (byId.get(r.category_id) ?? null) : null,
    amount_pence: r.amount_pence,
    incurred_on: r.incurred_on,
    description: r.description,
    has_receipt: !!r.doc_path,
  }));
}

/** Registration-labelled vehicle options for a tenant, for expense/charge pickers. */
export async function listVehicleOptions(tenantId: string): Promise<{ id: string; registration: string }[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('vehicles')
    .select('id, registration')
    .eq('tenant_id', tenantId)
    .order('registration');
  return (data ?? []) as { id: string; registration: string }[];
}

/** Totals by category (pence), for the finance summary. */
export async function expenseSummaryByCategory(tenantId: string): Promise<{ category: string; total_pence: number }[]> {
  const expenses = await listExpenses(tenantId, 5000);
  const totals = new Map<string, number>();
  for (const e of expenses) {
    const key = e.category ?? 'Uncategorised';
    totals.set(key, (totals.get(key) ?? 0) + e.amount_pence);
  }
  return [...totals.entries()].map(([category, total_pence]) => ({ category, total_pence })).sort((a, b) => b.total_pence - a.total_pence);
}
