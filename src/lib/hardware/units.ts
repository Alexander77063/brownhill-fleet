/**
 * Stock — the tracker units we buy, register in Traccar, and fit. A unit is
 * known by its IMEI from the day it arrives; the state ledger in ./derive.ts
 * says where it may go next, and every move leaves a timeline event.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { nextUnitState, UNIT_STATES, type UnitEvent, type UnitState } from './derive';
import { hardwareEvent } from './events';
import type { TraccarClient } from './traccar';

type Sb = ReturnType<typeof createServiceClient>;

export interface UnitRow {
  id: string;
  imei: string;
  iccid: string | null;
  msisdn: string | null;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  hasImmobiliser: boolean;
  batchRef: string | null;
  purchasedOn: string | null;
  unitCostMinor: number;
  state: UnitState;
  tenantId: string | null;
  tenantName: string | null;
  vehicleId: string | null;
  registration: string | null;
  traccarDeviceId: number | null;
  traccarPending: boolean;
  lastSeenAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface NewUnit {
  imei: string;
  iccid?: string | null;
  msisdn?: string | null;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  hasImmobiliser?: boolean;
  batchRef?: string | null;
  purchasedOn?: string | null;
  unitCostMinor?: number;
  notes?: string | null;
}

/** IMEIs are 15 digits; some vendors ship 14–17. Anything else is a typo. */
export const IMEI_PATTERN = /^\d{14,17}$/;

const CSV_COLUMNS = ['imei', 'iccid', 'msisdn', 'vendor', 'model', 'firmware', 'immobiliser', 'batch', 'purchased_on', 'unit_cost_minor', 'notes'] as const;

/**
 * Parse the stock CSV the console accepts: a header row naming any of
 * imei, iccid, msisdn, vendor, model, firmware, immobiliser (yes/no),
 * batch, purchased_on (YYYY-MM-DD), unit_cost_minor, notes. Only imei is
 * required. Bad rows are reported by line, good rows still load.
 */
export function parseUnitsCsv(text: string): { rows: NewUnit[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], errors: ['The file is empty.'] };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (name: (typeof CSV_COLUMNS)[number]) => header.indexOf(name);
  if (col('imei') < 0) return { rows: [], errors: ['The header row needs an "imei" column.'] };
  const rows: NewUnit[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split(',').map((c) => c.trim());
    const get = (name: (typeof CSV_COLUMNS)[number]) => {
      const idx = col(name);
      return idx >= 0 ? (cells[idx] ?? '') : '';
    };
    const imei = get('imei');
    if (!IMEI_PATTERN.test(imei)) {
      errors.push(`Line ${i + 1}: "${imei}" is not an IMEI.`);
      continue;
    }
    if (seen.has(imei)) {
      errors.push(`Line ${i + 1}: ${imei} appears twice.`);
      continue;
    }
    seen.add(imei);
    const cost = get('unit_cost_minor');
    const purchased = get('purchased_on');
    if (purchased && !/^\d{4}-\d{2}-\d{2}$/.test(purchased)) {
      errors.push(`Line ${i + 1}: purchased_on must be YYYY-MM-DD.`);
      continue;
    }
    if (cost && !/^\d+$/.test(cost)) {
      errors.push(`Line ${i + 1}: unit_cost_minor must be a whole number of minor units.`);
      continue;
    }
    rows.push({
      imei,
      iccid: get('iccid') || null,
      msisdn: get('msisdn') || null,
      vendor: get('vendor') || null,
      model: get('model') || null,
      firmware: get('firmware') || null,
      hasImmobiliser: /^(y|yes|true|1)$/i.test(get('immobiliser')),
      batchRef: get('batch') || null,
      purchasedOn: purchased || null,
      unitCostMinor: cost ? Number(cost) : 0,
      notes: get('notes') || null,
    });
  }
  return { rows, errors };
}

function toUnit(r: Record<string, unknown>): UnitRow {
  const veh = pick(r.vehicles) as { registration: string } | null;
  const ten = pick(r.tenants) as { name: string } | null;
  return {
    id: r.id as string,
    imei: r.imei as string,
    iccid: (r.iccid as string | null) ?? null,
    msisdn: (r.msisdn as string | null) ?? null,
    vendor: (r.vendor as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    firmware: (r.firmware as string | null) ?? null,
    hasImmobiliser: Boolean(r.has_immobiliser),
    batchRef: (r.batch_ref as string | null) ?? null,
    purchasedOn: (r.purchased_on as string | null) ?? null,
    unitCostMinor: Number(r.unit_cost_minor ?? 0),
    state: r.state as UnitState,
    tenantId: (r.tenant_id as string | null) ?? null,
    tenantName: ten?.name ?? null,
    vehicleId: (r.vehicle_id as string | null) ?? null,
    registration: veh?.registration ?? null,
    traccarDeviceId: r.traccar_device_id == null ? null : Number(r.traccar_device_id),
    traccarPending: Boolean(r.traccar_pending),
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function pick(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

const UNIT_SELECT = '*, vehicles(registration), tenants(name)';

/**
 * Receive units into stock. Each is registered in Traccar by IMEI when the
 * gateway is configured; otherwise it is flagged pending and a later
 * `registerPendingUnits` catches up. Duplicate IMEIs are skipped, not errors.
 */
export async function addUnits(
  rows: NewUnit[],
  actor: string,
  opts: { traccar?: TraccarClient | null; sb?: Sb } = {},
): Promise<{ added: number; skipped: { imei: string; reason: string }[]; traccarPending: number }> {
  const sb = opts.sb ?? createServiceClient();
  const skipped: { imei: string; reason: string }[] = [];
  let added = 0;
  let pending = 0;
  const imeis = rows.map((r) => r.imei);
  const { data: existing } = imeis.length ? await sb.from('device_units').select('imei').in('imei', imeis) : { data: [] };
  const known = new Set((existing ?? []).map((e) => e.imei as string));
  for (const r of rows) {
    if (!IMEI_PATTERN.test(r.imei)) {
      skipped.push({ imei: r.imei, reason: 'not an IMEI' });
      continue;
    }
    if (known.has(r.imei)) {
      skipped.push({ imei: r.imei, reason: 'already in stock' });
      continue;
    }
    let traccarId: number | null = null;
    let traccarPending = true;
    if (opts.traccar?.configured) {
      try {
        traccarId = await opts.traccar.ensureDevice(r.imei);
        traccarPending = false;
      } catch (e) {
        console.error('[hardware] traccar registration failed', r.imei, e);
      }
    }
    if (traccarPending) pending += 1;
    const { data, error } = await sb
      .from('device_units')
      .insert({
        imei: r.imei,
        iccid: r.iccid ?? null,
        msisdn: r.msisdn ?? null,
        vendor: r.vendor ?? null,
        model: r.model ?? null,
        firmware: r.firmware ?? null,
        has_immobiliser: Boolean(r.hasImmobiliser),
        batch_ref: r.batchRef ?? null,
        purchased_on: r.purchasedOn ?? null,
        unit_cost_minor: Math.max(0, Math.round(r.unitCostMinor ?? 0)),
        state: 'in_stock',
        traccar_device_id: traccarId,
        traccar_pending: traccarPending,
        notes: r.notes ?? null,
      } as never)
      .select('id')
      .single();
    if (error) {
      skipped.push({ imei: r.imei, reason: error.message });
      continue;
    }
    known.add(r.imei);
    added += 1;
    await hardwareEvent(sb, { unitId: (data as { id: string }).id, kind: 'received', actor, detail: { batchRef: r.batchRef ?? null, traccarPending } });
  }
  return { added, skipped, traccarPending: pending };
}

/** Register in Traccar every unit added while the gateway was unconfigured. */
export async function registerPendingUnits(traccar: TraccarClient, sb: Sb = createServiceClient()): Promise<{ registered: number; failed: number }> {
  if (!traccar.configured) return { registered: 0, failed: 0 };
  const { data } = await sb.from('device_units').select('id, imei, model').eq('traccar_pending', true).not('state', 'in', '(retired,lost)');
  let registered = 0;
  let failed = 0;
  for (const u of data ?? []) {
    try {
      const id = await traccar.ensureDevice(u.imei);
      await sb.from('device_units').update({ traccar_device_id: id, traccar_pending: false } as never).eq('id', u.id);
      await hardwareEvent(sb, { unitId: u.id, kind: 'traccar_registered', actor: 'system', detail: { traccarDeviceId: id } });
      registered += 1;
    } catch (e) {
      failed += 1;
      console.error('[hardware] traccar registration failed', u.imei, e);
    }
  }
  return { registered, failed };
}

export async function listUnits(filter: { state?: UnitState | 'all'; q?: string; limit?: number } = {}, sb: Sb = createServiceClient()): Promise<UnitRow[]> {
  let q = sb.from('device_units').select(UNIT_SELECT).order('created_at', { ascending: false }).limit(filter.limit ?? 500);
  if (filter.state && filter.state !== 'all') q = q.eq('state', filter.state);
  if (filter.q?.trim()) {
    const term = filter.q.trim().replace(/[%,()]/g, '');
    q = q.or(`imei.ilike.%${term}%,iccid.ilike.%${term}%,msisdn.ilike.%${term}%,batch_ref.ilike.%${term}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toUnit);
}

export async function unitByImei(imei: string, sb: Sb = createServiceClient()): Promise<UnitRow | null> {
  const { data } = await sb.from('device_units').select(UNIT_SELECT).eq('imei', imei.trim()).maybeSingle();
  return data ? toUnit(data as unknown as Record<string, unknown>) : null;
}

export async function unitById(id: string, sb: Sb = createServiceClient()): Promise<UnitRow | null> {
  const { data } = await sb.from('device_units').select(UNIT_SELECT).eq('id', id).maybeSingle();
  return data ? toUnit(data as unknown as Record<string, unknown>) : null;
}

/** Units in stock that can be fitted, oldest first (FIFO). */
export async function fittableUnits(sb: Sb = createServiceClient()): Promise<UnitRow[]> {
  const { data } = await sb.from('device_units').select(UNIT_SELECT).in('state', ['in_stock', 'allocated']).order('created_at');
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toUnit);
}

export async function stockSummary(sb: Sb = createServiceClient()): Promise<Record<UnitState, number> & { traccarPending: number }> {
  const { data } = await sb.from('device_units').select('state, traccar_pending');
  const out = Object.fromEntries(UNIT_STATES.map((s) => [s, 0])) as Record<UnitState, number>;
  let pending = 0;
  for (const r of data ?? []) {
    const s = r.state as UnitState;
    if (s in out) out[s] += 1;
    if (r.traccar_pending) pending += 1;
  }
  return { ...out, traccarPending: pending };
}

/**
 * Move a unit through the ledger. Leaving a vehicle (return / restock / retire /
 * lose) clears its tenant and vehicle; the timeline keeps where it was.
 */
export async function moveUnit(
  unitId: string,
  event: UnitEvent,
  actor: string,
  detail: Record<string, unknown> = {},
  sb: Sb = createServiceClient(),
): Promise<UnitState> {
  const { data: u } = await sb.from('device_units').select('id, state, tenant_id, vehicle_id').eq('id', unitId).maybeSingle();
  if (!u) throw new Error('Unit not found.');
  const to = nextUnitState(u.state as UnitState, event);
  const patch: Record<string, unknown> = { state: to, updated_at: new Date().toISOString() };
  if (event === 'return' || event === 'restock' || event === 'retire' || event === 'lose') {
    patch.tenant_id = null;
    patch.vehicle_id = null;
  }
  if (event === 'fault') patch.vehicle_id = null;
  const { error } = await sb.from('device_units').update(patch as never).eq('id', unitId);
  if (error) throw new Error(error.message);
  await hardwareEvent(sb, { unitId, tenantId: u.tenant_id ?? null, kind: `unit_${to}`, actor, detail: { from: u.state, event, ...detail } });
  return to;
}
