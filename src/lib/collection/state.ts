/**
 * The subscription status machine — pure, unit-tested.
 *
 *   unpaid ──(first invoice paid)──▶ active ──(anniversary passes unpaid)──▶ past_due
 *      ▲                               ▲  ▲                                      │ grace_days
 *      │                               │  └──── payment ─────────────────────────┤
 *   new tenant on ng             payment / admin                                  ▼
 *                                      └─────────────────────────────────── suspended
 *                                                                                 │ cancel_days
 *                                                                                 ▼
 *                                                                             cancelled
 *
 * Day counts come from the console settings; the only thing fixed here is the
 * shape of the ladder. `past_due` keeps full service (we chase while the customer
 * still has protection); `suspended` keeps only the emergency line; `unpaid` and
 * `cancelled` have nothing. "Serviceable" is the word the rest of the code uses.
 */
import { dayDiff } from './pricing';

export type SubStatus = 'trialing' | 'unpaid' | 'active' | 'past_due' | 'suspended' | 'cancelled';

export const SERVICEABLE: ReadonlySet<SubStatus> = new Set<SubStatus>(['trialing', 'active', 'past_due']);

export function isServiceable(status: string | null | undefined): boolean {
  return SERVICEABLE.has(status as SubStatus);
}

export interface SubSnapshot {
  status: SubStatus;
  /** The renewal date (ISO). Null before the first payment. */
  anniversaryOn: string | null;
  /** When the anniversary passed unpaid (ISO). Null unless past_due/suspended. */
  pastDueSince: string | null;
}

export interface RenewalDue {
  /** Period the unpaid renewal invoice covers — starts on the anniversary. */
  periodStart: string;
}

export type TransitionEvent = 'past_due' | 'suspended' | 'cancelled';
export type Transition = { to: SubStatus; event: TransitionEvent; pastDueSince: string } | null;

/**
 * What, if anything, the daily run should do to this subscription today.
 *
 * - active, anniversary before today, renewal unpaid → past_due (dated from the anniversary)
 * - past_due for ≥ grace_days → suspended
 * - suspended for ≥ cancel_days (counted from the same anniversary) → cancelled
 * - anything else → nothing (unpaid never times out on its own; trialing is the UK's)
 *
 * A subscription whose renewal was paid never reaches here as past_due: payment
 * moves the anniversary forward (see periodAfterPayment).
 */
export function nextTransition(
  sub: SubSnapshot,
  renewalUnpaid: RenewalDue | null,
  settings: { 'collection.grace_days': number; 'collection.cancel_days': number },
  todayISO: string,
): Transition {
  if (sub.status === 'active') {
    if (!sub.anniversaryOn || !renewalUnpaid) return null;
    if (dayDiff(sub.anniversaryOn, todayISO) <= 0) return null;
    return { to: 'past_due', event: 'past_due', pastDueSince: sub.anniversaryOn };
  }
  if (sub.status === 'past_due') {
    const since = sub.pastDueSince ?? sub.anniversaryOn;
    if (!since) return null;
    if (dayDiff(since, todayISO) >= settings['collection.grace_days']) return { to: 'suspended', event: 'suspended', pastDueSince: since };
    return null;
  }
  if (sub.status === 'suspended') {
    const since = sub.pastDueSince ?? sub.anniversaryOn;
    if (!since) return null;
    if (dayDiff(since, todayISO) >= settings['collection.cancel_days']) return { to: 'cancelled', event: 'cancelled', pastDueSince: since };
    return null;
  }
  return null;
}

/**
 * The period a payment buys.
 *
 * An initial invoice was issued with today as its period start, so paying it
 * starts the term today. A renewal's period starts on the anniversary whether
 * it is paid early or late: a customer who pays on day 10 of grace is not given
 * ten free days, and one who pays early is not shortened.
 */
export function periodAfterPayment(invoice: { kind: string; periodStart: string | null; periodEnd: string | null }, todayISO: string): { start: string; end: string } | null {
  if (!invoice.periodEnd) return null;
  if (invoice.kind === 'initial') return { start: todayISO, end: invoice.periodEnd };
  if (invoice.kind === 'renewal' && invoice.periodStart) return { start: invoice.periodStart, end: invoice.periodEnd };
  return null;
}

/** Days until the anniversary (negative = overdue). */
export function daysToAnniversary(sub: Pick<SubSnapshot, 'anniversaryOn'>, todayISO: string): number | null {
  return sub.anniversaryOn ? dayDiff(todayISO, sub.anniversaryOn) : null;
}

/** Human label for a status — one place, so every surface says the same thing. */
export function statusLabel(status: SubStatus): string {
  switch (status) {
    case 'trialing':
      return 'Trial';
    case 'unpaid':
      return 'Awaiting first payment';
    case 'active':
      return 'Active';
    case 'past_due':
      return 'Payment overdue';
    case 'suspended':
      return 'Suspended — payment required';
    case 'cancelled':
      return 'Cancelled';
  }
}
