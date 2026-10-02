/**
 * Pure rules for hardware jobs (NG-3 §4): which jobs a paid invoice creates,
 * when they are due, whether a unit is under warranty, and the legal moves of
 * a stock unit. No I/O — the services in ./jobs.ts feed and persist these.
 */
import { addDaysISO } from '@/lib/collection/pricing';

export type JobKind = 'install' | 'replace' | 'remove' | 'service';
export const JOB_KINDS: readonly JobKind[] = ['install', 'replace', 'remove', 'service'];
export type JobStatus = 'pending' | 'scheduled' | 'in_progress' | 'done' | 'failed' | 'cancelled';
export const OPEN_JOB_STATUSES: readonly JobStatus[] = ['pending', 'scheduled', 'in_progress'];
export type UnitState = 'in_stock' | 'allocated' | 'fitted' | 'faulty' | 'returned' | 'retired' | 'lost';
export const UNIT_STATES: readonly UnitState[] = ['in_stock', 'allocated', 'fitted', 'faulty', 'returned', 'retired', 'lost'];

export interface LineForJobs {
  addonId: string;
  jobKind: JobKind | null;
  vehicleId: string | null;
  quantity: number;
}

export interface VehicleForJobs {
  id: string;
  /** An ACTIVE hardware device row exists for it. */
  hasFittedDevice: boolean;
  /** Kinds of jobs already open for it (from earlier invoices or faults). */
  openJobs: JobKind[];
  createdAt: string;
}

export interface DerivedJob {
  vehicleId: string | null;
  kind: JobKind;
  addonIds: string[];
}

/** Whether a job of this kind can be placed on this vehicle. */
function eligible(v: VehicleForJobs, kind: JobKind): boolean {
  if (v.openJobs.includes(kind)) return false;
  return kind === 'install' ? !v.hasFittedDevice : v.hasFittedDevice;
}

/**
 * One job per (vehicle, kind), merging the items it fulfils. Vehicle-keyed
 * lines land on their vehicle; quantity lines (the initial invoice prices
 * "2 × tracker" without naming cars) fan out across eligible vehicles, oldest
 * first, each vehicle taking one of every quantity line of that kind. Whatever
 * cannot be placed is the shortfall — the console shows it, nothing is lost.
 */
export function deriveJobs(lines: LineForJobs[], vehicles: VehicleForJobs[]): { jobs: DerivedJob[]; shortfall: number } {
  const jobs = new Map<string, DerivedJob>();
  const key = (vehicleId: string, kind: JobKind) => `${vehicleId}|${kind}`;
  const add = (vehicleId: string, kind: JobKind, addonId: string) => {
    const k = key(vehicleId, kind);
    const j = jobs.get(k) ?? { vehicleId, kind, addonIds: [] };
    if (!j.addonIds.includes(addonId)) j.addonIds.push(addonId);
    jobs.set(k, j);
  };

  const quantityLines = new Map<JobKind, { addonId: string; remaining: number }[]>();
  for (const l of lines) {
    if (!l.jobKind || l.quantity <= 0) continue;
    if (l.vehicleId) {
      add(l.vehicleId, l.jobKind, l.addonId);
      continue;
    }
    const arr = quantityLines.get(l.jobKind) ?? [];
    arr.push({ addonId: l.addonId, remaining: l.quantity });
    quantityLines.set(l.jobKind, arr);
  }

  const ordered = [...vehicles].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  let shortfall = 0;
  for (const [kind, items] of quantityLines) {
    for (const v of ordered) {
      if (items.every((i) => i.remaining <= 0)) break;
      // A vehicle already named by a line of this kind does not also take a quantity slot.
      if (jobs.has(key(v.id, kind)) || !eligible(v, kind)) continue;
      for (const i of items) {
        if (i.remaining <= 0) continue;
        add(v.id, kind, i.addonId);
        i.remaining -= 1;
      }
    }
    shortfall += items.reduce((s, i) => s + Math.max(0, i.remaining), 0);
  }
  return { jobs: [...jobs.values()], shortfall };
}

/** The day a job must be done by: paid day + the console's SLA. */
export function slaDueOn(paidOnISO: string, slaDays: number): string {
  return addDaysISO(paidOnISO, Math.max(0, Math.floor(slaDays)));
}

/** Same calendar day N months after fitting (clamped for short months). */
export function warrantyUntil(fittedAtISO: string, warrantyMonths: number): string {
  const d = new Date(`${fittedAtISO.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Math.max(0, Math.floor(warrantyMonths)));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** Under warranty through the last day (inclusive). Never fitted = never covered. */
export function underWarranty(fittedAtISO: string | null, warrantyMonths: number, todayISO: string): boolean {
  if (!fittedAtISO) return false;
  return todayISO.slice(0, 10) <= warrantyUntil(fittedAtISO, warrantyMonths);
}

export type UnitEvent = 'allocate' | 'fit' | 'fault' | 'return' | 'restock' | 'retire' | 'lose';

const MOVES: Record<UnitEvent, { from: UnitState[]; to: UnitState }> = {
  allocate: { from: ['in_stock'], to: 'allocated' },
  fit: { from: ['in_stock', 'allocated'], to: 'fitted' },
  fault: { from: ['fitted', 'allocated', 'in_stock'], to: 'faulty' },
  return: { from: ['fitted', 'faulty', 'allocated'], to: 'returned' },
  restock: { from: ['returned', 'allocated', 'faulty'], to: 'in_stock' },
  retire: { from: ['in_stock', 'allocated', 'faulty', 'returned'], to: 'retired' },
  lose: { from: ['in_stock', 'allocated', 'fitted', 'faulty', 'returned'], to: 'lost' },
};

/** The next state of a unit, or a thrown error for a move the stock ledger does not allow. */
export function nextUnitState(from: UnitState, event: UnitEvent): UnitState {
  const m = MOVES[event];
  if (!m.from.includes(from)) throw new Error(`A ${from} unit cannot ${event}.`);
  return m.to;
}
