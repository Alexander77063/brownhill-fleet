/**
 * Pricing for the protection subscription — pure, no I/O, unit-tested.
 *
 * Everything here is integer minor units (kobo). The plan price is the console's
 * VAT-exclusive per-vehicle price for the plan's own term; VAT is added per line
 * at the rate the caller takes from the region pack; one-off items (hardware,
 * installation) are never prorated and never recur.
 *
 * The one rule that is enforced here rather than merely displayed: a per-vehicle
 * plan at 0 is UNPRICED, and nothing may be invoiced against it. `UnpricedError`
 * is thrown before any line exists, so a caller can never half-issue.
 */

export type Interval = 'month' | 'half_year' | 'year';

export interface PriceablePlan {
  id: string;
  key: string;
  name: string;
  /** Console price per vehicle for the plan's own term, VAT-exclusive, minor units. */
  base_price_pence: number;
  interval: Interval;
  per_vehicle: boolean;
  region: string | null;
}

export interface OneOffItem {
  id: string;
  key: string;
  name: string;
  unit_price_pence: number;
  active: boolean;
}

export interface LineVehicle {
  id: string;
  registration: string;
  /** For additions: the day this vehicle joined (ISO). Defaults to the draft's addedOn. */
  addedOn?: string;
}

export type LineKind = 'subscription' | 'one_off' | 'proration' | 'credit';

export interface DraftLine {
  kind: LineKind;
  description: string;
  planId?: string;
  addonId?: string;
  vehicleId?: string;
  quantity: number;
  unitMinor: number;
  netMinor: number;
  vatRate: number;
  vatMinor: number;
  grossMinor: number;
  periodStart?: string;
  periodEnd?: string;
}

export class UnpricedError extends Error {
  constructor(public readonly what: string) {
    super(`${what} is unpriced — set a price in the platform console before invoicing.`);
    this.name = 'UnpricedError';
  }
}

/** The NG-1 invariant: `per_vehicle && base_price_pence = 0` ⇒ no invoice may be raised. */
export function isUnpriced(p: { per_vehicle: boolean; base_price_pence: number }): boolean {
  return p.per_vehicle && p.base_price_pence === 0;
}

export function isUnpricedItem(i: { unit_price_pence: number }): boolean {
  return i.unit_price_pence === 0;
}

export function termMonths(interval: Interval): 1 | 6 | 12 {
  switch (interval) {
    case 'month':
      return 1;
    case 'half_year':
      return 6;
    case 'year':
      return 12;
  }
}

// ── Dates: ISO 'YYYY-MM-DD', arithmetic in UTC so a Lagos midnight never shifts a day ──

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Not an ISO date: ${iso}`);
  return { y, m, d };
}

function iso(y: number, m0: number, d: number): string {
  return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
}

function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** Whole days from `a` to `b` (negative when b is before a). */
export function dayDiff(aISO: string, bISO: string): number {
  const a = parts(aISO);
  const b = parts(bISO);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** `iso` plus `days` calendar days. */
export function addDaysISO(isoDate: string, days: number): string {
  const { y, m, d } = parts(isoDate);
  return iso(y, m - 1, d + days);
}

/** The day a term starting on `startISO` ends: start + term, day clamped to the target month. */
export function termEnd(startISO: string, interval: Interval): string {
  const { y, m, d } = parts(startISO);
  const totalMonths = m - 1 + termMonths(interval);
  const ty = y + Math.floor(totalMonths / 12);
  const tm0 = totalMonths % 12;
  return iso(ty, tm0, Math.min(d, daysInMonth(ty, tm0)));
}

/** Fraction of the period [start, end) remaining on `fromISO`, clamped to 0..1. */
export function prorataFraction(fromISO: string, periodStartISO: string, periodEndISO: string): number {
  const total = dayDiff(periodStartISO, periodEndISO);
  if (total <= 0) return 0;
  const remaining = dayDiff(fromISO, periodEndISO);
  return Math.min(1, Math.max(0, remaining / total));
}

// ── Money ────────────────────────────────────────────────────────────────────

export function vatOf(netMinor: number, rate: number): number {
  return Math.round(netMinor * rate);
}

function line(
  kind: LineKind,
  description: string,
  quantity: number,
  unitMinor: number,
  vatRate: number,
  extra: Partial<Pick<DraftLine, 'planId' | 'addonId' | 'vehicleId' | 'periodStart' | 'periodEnd'>> = {},
): DraftLine {
  const netMinor = unitMinor * quantity;
  const vatMinor = vatOf(netMinor, vatRate);
  return { kind, description, quantity, unitMinor, netMinor, vatRate, vatMinor, grossMinor: netMinor + vatMinor, ...extra };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The recurring line for a whole term: one line, quantity = vehicles. */
export function subscriptionLines(
  plan: PriceablePlan,
  vehicles: LineVehicle[],
  period: { start: string; end: string },
  vatRate: number,
): DraftLine[] {
  if (isUnpriced(plan)) throw new UnpricedError(plan.name);
  if (vehicles.length === 0) return [];
  return [
    line('subscription', `${plan.name} — ${plural(vehicles.length, 'vehicle')}, ${period.start} to ${period.end}`, vehicles.length, plan.base_price_pence, vatRate, {
      planId: plan.id,
      periodStart: period.start,
      periodEnd: period.end,
    }),
  ];
}

/**
 * One-off items for a set of vehicles. `perVehicle` writes one line per vehicle
 * (so an addition can be traced to the car); otherwise one line per item with
 * quantity = vehicles, which keeps a 300-vehicle insurer invoice readable.
 */
export function oneOffLinesFor(
  items: OneOffItem[],
  vehicles: LineVehicle[],
  vatRate: number,
  opts: { perVehicle?: boolean } = {},
): DraftLine[] {
  const active = items.filter((i) => i.active);
  for (const i of active) if (isUnpricedItem(i)) throw new UnpricedError(i.name);
  if (vehicles.length === 0) return [];
  if (opts.perVehicle) {
    return active.flatMap((i) =>
      vehicles.map((v) => line('one_off', `${i.name} — ${v.registration}`, 1, i.unit_price_pence, vatRate, { addonId: i.id, vehicleId: v.id })),
    );
  }
  return active.map((i) => line('one_off', `${i.name} × ${plural(vehicles.length, 'vehicle')}`, vehicles.length, i.unit_price_pence, vatRate, { addonId: i.id }));
}

/**
 * Vehicles added mid-term: pro-rata to the anniversary per vehicle, plus the
 * plan's one-off items in full. A vehicle added on the period's first day pays
 * the whole term; one added after the period has ended pays nothing here (the
 * renewal invoice will carry it).
 */
export function additionLines(
  plan: PriceablePlan,
  vehicles: LineVehicle[],
  addedOnISO: string,
  period: { start: string; end: string },
  vatRate: number,
  oneOffs: OneOffItem[],
): DraftLine[] {
  if (isUnpriced(plan)) throw new UnpricedError(plan.name);
  const proration = vehicles.map((v) => {
    // A vehicle added before the period began pays from the period start, not from before it.
    const from = (v.addedOn ?? addedOnISO) < period.start ? period.start : (v.addedOn ?? addedOnISO);
    const unit = Math.round(plan.base_price_pence * prorataFraction(from, period.start, period.end));
    return line('proration', `${plan.name} — ${v.registration}, ${from} to ${period.end} (pro rata)`, 1, unit, vatRate, {
      planId: plan.id,
      vehicleId: v.id,
      periodStart: from,
      periodEnd: period.end,
    });
  });
  return [...proration, ...oneOffLinesFor(oneOffs, vehicles, vatRate, { perVehicle: true })];
}

/** Ad-hoc one-off lines (a replacement device, an extra installation). */
export function oneOffLines(
  picks: { item: OneOffItem; quantity: number; vehicleId?: string; registration?: string }[],
  vatRate: number,
): DraftLine[] {
  return picks.map(({ item, quantity, vehicleId, registration }) => {
    if (isUnpricedItem(item)) throw new UnpricedError(item.name);
    if (quantity < 1) throw new Error(`Quantity must be at least 1 for ${item.name}.`);
    return line('one_off', registration ? `${item.name} — ${registration}` : item.name, quantity, item.unit_price_pence, vatRate, {
      addonId: item.id,
      vehicleId,
    });
  });
}

/** A manual credit (negative net) — used by the console only. */
export function creditLine(description: string, netMinor: number, vatRate: number): DraftLine {
  if (netMinor >= 0) throw new Error('A credit must be negative.');
  return line('credit', description, 1, netMinor, vatRate);
}

/** Totals are sums of lines, never a recomputation on the total, so the invoice foots. */
export function totals(lines: DraftLine[]): { netMinor: number; vatMinor: number; grossMinor: number } {
  return lines.reduce(
    (t, l) => ({ netMinor: t.netMinor + l.netMinor, vatMinor: t.vatMinor + l.vatMinor, grossMinor: t.grossMinor + l.grossMinor }),
    { netMinor: 0, vatMinor: 0, grossMinor: 0 },
  );
}
