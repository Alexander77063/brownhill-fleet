/**
 * Bulk import for vehicles & drivers from a spreadsheet. Accepts CSV (Excel →
 * Save As CSV) so it stays dependency-free. Always validates first and supports a
 * dry-run preview, so an operator sees exactly what will import — and what won't,
 * and why — before committing anything.
 */

import { normalisePhone } from '@/lib/phone';
import { upsertOwnerByPhone } from '@/lib/owners';
import { createServiceClient } from '@/lib/supabase/server';

/** Minimal, correct CSV parser: handles quoted fields, embedded commas/newlines,
 * and "" escapes. Returns objects keyed by the (lower-cased, trimmed) header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length < 2) return [];
  const headers = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => (o[h] = (r[idx] ?? '').trim()));
    return o;
  });
}

export interface ImportError {
  row: number; // 1-based data row
  message: string;
}
export interface ImportResult {
  entity: 'vehicles' | 'drivers' | 'pcn';
  dryRun: boolean;
  total: number;
  valid: number;
  inserted: number;
  errors: ImportError[];
  /** PCN import: rows skipped because the same PCN was already imported. */
  skipped?: number;
  /** Vehicle import with owner columns: owners that will be / were created vs matched by phone. */
  owners?: { create: number; match: number };
}

/** An owner named on a vehicle row (owner_name / owner_phone / owner_email). */
interface OwnerSpec {
  name: string;
  phone: string;
  email: string | null;
}

const FUEL = new Set(['phev', 'ev', 'petrol', 'diesel', 'hybrid']);
const VEHICLE_STATUS = new Set(['available', 'on_hire', 'off_road', 'sold']);
const DRIVER_STATUS = new Set(['lead', 'vetting', 'active', 'suspended', 'terminated']);

const pence = (v: string): number | null => {
  if (!v) return null;
  const n = Number(v.replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

function mapVehicles(rows: Record<string, string>[]): {
  valid: Record<string, unknown>[];
  errors: ImportError[];
  /** Owner named on each valid row, keyed by the row's index in `valid`. */
  owners: Map<number, OwnerSpec>;
} {
  const valid: Record<string, unknown>[] = [];
  const errors: ImportError[] = [];
  const owners = new Map<number, OwnerSpec>();
  rows.forEach((r, i) => {
    const rn = i + 1;
    const reg = r.registration || r.reg || r.vrm;
    if (!reg) return errors.push({ row: rn, message: 'registration is required' });
    let owner: OwnerSpec | null = null;
    if (r.owner_phone) {
      if (!r.owner_name) return errors.push({ row: rn, message: 'owner_name is required when owner_phone is given' });
      const phone = normalisePhone(r.owner_phone);
      if (!phone) return errors.push({ row: rn, message: `owner_phone "${r.owner_phone}" is not a valid mobile number` });
      owner = { name: r.owner_name, phone, email: r.owner_email || null };
    }
    const value = pence(r.list_value || r.value || r.list_value_pence);
    if (value == null || value < 0) return errors.push({ row: rn, message: 'list_value must be a positive amount' });
    if (r.fuel && !FUEL.has(r.fuel.toLowerCase())) return errors.push({ row: rn, message: `invalid fuel "${r.fuel}"` });
    if (r.status && !VEHICLE_STATUS.has(r.status.toLowerCase())) return errors.push({ row: rn, message: `invalid status "${r.status}"` });
    if (r.model_year && !/^\d{4}$/.test(r.model_year)) return errors.push({ row: rn, message: 'model_year must be a 4-digit year' });
    for (const [k, col] of [['mot_due', 'mot_due_on'], ['ved_renewal', 'ved_renewal_on']] as const) {
      if (r[k] && !isDate(r[k])) return errors.push({ row: rn, message: `${k} must be YYYY-MM-DD` });
    }
    valid.push({
      registration: reg,
      // Omitted, not null: both columns are NOT NULL with a default, and an
      // explicit null fails the whole import for a sheet that simply has no
      // make/model column.
      make: r.make || undefined,
      model: r.model || undefined,
      colour: r.colour || null,
      model_year: r.model_year ? Number(r.model_year) : null,
      fuel: r.fuel ? r.fuel.toLowerCase() : undefined,
      list_value_pence: value,
      vin: r.vin || null,
      mot_due_on: r.mot_due || null,
      ved_renewal_on: r.ved_renewal || null,
      status: r.status ? r.status.toLowerCase() : undefined,
    });
    if (owner) owners.set(valid.length - 1, owner);
  });
  return { valid, errors, owners };
}

function mapDrivers(rows: Record<string, string>[]): { valid: Record<string, unknown>[]; errors: ImportError[] } {
  const valid: Record<string, unknown>[] = [];
  const errors: ImportError[] = [];
  rows.forEach((r, i) => {
    const rn = i + 1;
    const name = r.full_name || r.name;
    if (!name) return errors.push({ row: rn, message: 'full_name is required' });
    if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) return errors.push({ row: rn, message: `invalid email "${r.email}"` });
    if (r.status && !DRIVER_STATUS.has(r.status.toLowerCase())) return errors.push({ row: rn, message: `invalid status "${r.status}"` });
    if (r.pco_licence_expiry && !isDate(r.pco_licence_expiry)) return errors.push({ row: rn, message: 'pco_licence_expiry must be YYYY-MM-DD' });
    valid.push({
      full_name: name,
      email: r.email || null,
      phone: r.phone || null,
      pco_licence_no: r.pco_licence_no || null,
      pco_licence_expiry: r.pco_licence_expiry || null,
      dvla_licence_no: r.dvla_licence_no || null,
      status: r.status ? r.status.toLowerCase() : undefined,
    });
  });
  return { valid, errors };
}

async function runImport(
  entity: 'vehicles' | 'drivers',
  tenantId: string,
  csv: string,
  dryRun: boolean,
  actor: string,
): Promise<ImportResult> {
  const rows = parseCsv(csv);
  const mapped = entity === 'vehicles' ? mapVehicles(rows) : { ...mapDrivers(rows), owners: new Map<number, OwnerSpec>() };
  const { valid, errors, owners } = mapped;
  let inserted = 0;
  const sb = createServiceClient();

  // Owners named on vehicle rows: how many are new vs already on file, by phone.
  // Counted in a dry run too, so the preview says what will happen to them.
  let ownerCounts: { create: number; match: number } | undefined;
  if (owners.size > 0) {
    const phones = [...new Set([...owners.values()].map((o) => o.phone))];
    const { data: existing } = await sb.from('vehicle_owners').select('phone').eq('tenant_id', tenantId).in('phone', phones);
    const known = new Set((existing ?? []).map((o) => o.phone as string));
    ownerCounts = { create: phones.filter((p) => !known.has(p)).length, match: phones.filter((p) => known.has(p)).length };
  }

  if (!dryRun && valid.length > 0) {
    const payload = valid.map((v) => ({ ...v, tenant_id: tenantId }));
    // defaultToNull:false → columns a row omits take the table default (make,
    // model, fuel, status) instead of null, which their NOT NULL constraints reject.
    const { data: created, error } = await sb
      .from(entity)
      .insert(payload as never, { defaultToNull: false })
      .select('id');
    if (error) throw new Error(`Import failed: ${error.message}`);
    inserted = valid.length;

    // Attach owners in row order: insert(...).select() returns rows in input order.
    if (entity === 'vehicles' && owners.size > 0 && created) {
      const ownerIdByPhone = new Map<string, string>();
      for (const [rowIdx, spec] of owners) {
        let ownerId = ownerIdByPhone.get(spec.phone);
        if (!ownerId) {
          ownerId = (await upsertOwnerByPhone(tenantId, spec, sb)).id;
          ownerIdByPhone.set(spec.phone, ownerId);
        }
        const vehicleId = (created[rowIdx] as { id: string } | undefined)?.id;
        if (vehicleId) await sb.from('vehicles').update({ owner_id: ownerId } as never).eq('tenant_id', tenantId).eq('id', vehicleId);
      }
    }

    await sb.rpc('log_audit', {
      p_tenant: tenantId,
      p_action: `import.${entity}`,
      p_entity_type: entity,
      p_detail: { inserted, errors: errors.length, owners: ownerCounts ?? null } as never,
      p_actor: actor,
    });
  }

  return { entity, dryRun, total: rows.length, valid: valid.length, inserted, errors, ...(ownerCounts ? { owners: ownerCounts } : {}) };
}

export const importVehicles = (tenantId: string, csv: string, dryRun: boolean, actor: string) =>
  runImport('vehicles', tenantId, csv, dryRun, actor);
export const importDrivers = (tenantId: string, csv: string, dryRun: boolean, actor: string) =>
  runImport('drivers', tenantId, csv, dryRun, actor);

/** Registration match key: spaces stripped, upper-cased (registrations are stored
 *  with a space, e.g. "LX24 AAA", but a PCN file may omit it). */
const normaliseReg = (reg: string): string => reg.replace(/\s+/g, '').toUpperCase();

/**
 * Import PCNs and turn each into a `charges` row (`type='pcn'`), assigned to a
 * vehicle by matching the CSV registration to a fleet vehicle (space/case
 * insensitive), and to that vehicle's current driver via its active agreement.
 * Re-importing is safe: a PCN whose (authority, reference) already exists for the
 * tenant is skipped, not duplicated (there is no DB unique constraint on charges).
 * Columns: reference, registration, authority, amount, incident_on (optional).
 */
export async function importPcns(
  tenantId: string,
  csv: string,
  dryRun: boolean,
  actor: string,
): Promise<ImportResult> {
  const rows = parseCsv(csv);
  const errors: ImportError[] = [];
  const sb = createServiceClient();

  // Tenant vehicles → normalised registration map (single query).
  const { data: vehicles } = await sb.from('vehicles').select('id, registration').eq('tenant_id', tenantId);
  const byReg = new Map<string, string>();
  for (const v of (vehicles ?? []) as { id: string; registration: string }[]) {
    byReg.set(normaliseReg(v.registration), v.id);
  }

  // Existing PCNs (authority|reference) for dedupe — also catches in-file duplicates.
  const { data: existing } = await sb
    .from('charges')
    .select('reference, authority')
    .eq('tenant_id', tenantId)
    .eq('type', 'pcn');
  const seen = new Set<string>();
  const dupeKey = (authority: string, reference: string) => `${authority.toLowerCase()}|${reference.toLowerCase()}`;
  for (const e of (existing ?? []) as { reference: string | null; authority: string | null }[]) {
    if (e.reference) seen.add(dupeKey(e.authority ?? '', e.reference));
  }

  // Resolve (and cache) the current driver of each matched vehicle.
  const driverCache = new Map<string, { driverId: string | null; agreementId: string | null }>();
  async function driverFor(vehicleId: string) {
    const cached = driverCache.get(vehicleId);
    if (cached) return cached;
    const { data: ag } = await sb
      .from('agreements')
      .select('id, driver_id')
      .eq('vehicle_id', vehicleId)
      .eq('status', 'active')
      .maybeSingle();
    const resolved = {
      driverId: (ag as { driver_id: string } | null)?.driver_id ?? null,
      agreementId: (ag as { id: string } | null)?.id ?? null,
    };
    driverCache.set(vehicleId, resolved);
    return resolved;
  }

  const today = new Date().toISOString().slice(0, 10);
  const reportDueAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const valid: Record<string, unknown>[] = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rn = i + 1;
    const reference = r.reference || r.ref || r.pcn || r.pcn_reference;
    const reg = r.registration || r.reg || r.vrm;
    const authority = r.authority || r.issuer || '';
    const amount = pence(r.amount || r.amount_pence || r.value);
    const incidentOn = r.incident_on || r.date || '';

    if (!reference) { errors.push({ row: rn, message: 'reference is required' }); continue; }
    if (!reg) { errors.push({ row: rn, message: 'registration is required' }); continue; }
    if (amount == null || amount < 0) { errors.push({ row: rn, message: 'amount must be a positive value' }); continue; }
    if (incidentOn && !isDate(incidentOn)) { errors.push({ row: rn, message: 'incident_on must be YYYY-MM-DD' }); continue; }

    const vehicleId = byReg.get(normaliseReg(reg));
    if (!vehicleId) { errors.push({ row: rn, message: `no vehicle found for registration "${reg}"` }); continue; }

    const key = dupeKey(authority, reference);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);

    const { driverId, agreementId } = await driverFor(vehicleId);
    valid.push({
      vehicle_id: vehicleId,
      driver_id: driverId,
      agreement_id: agreementId,
      type: 'pcn',
      authority: authority || null,
      reference,
      incident_on: incidentOn || null,
      received_on: today,
      report_due_at: reportDueAt,
      amount_pence: amount,
      status: 'received',
      submitted_by_driver: false,
    });
  }

  let inserted = 0;
  if (!dryRun && valid.length > 0) {
    const payload = valid.map((v) => ({ ...v, tenant_id: tenantId }));
    const { error } = await sb.from('charges').insert(payload as never);
    if (error) throw new Error(`Import failed: ${error.message}`);
    inserted = valid.length;
    await sb.rpc('log_audit', {
      p_tenant: tenantId,
      p_action: 'import.pcn',
      p_entity_type: 'charge',
      p_detail: { inserted, skipped, errors: errors.length } as never,
      p_actor: actor,
    });
  }

  return { entity: 'pcn', dryRun, total: rows.length, valid: valid.length, inserted, errors, skipped };
}
