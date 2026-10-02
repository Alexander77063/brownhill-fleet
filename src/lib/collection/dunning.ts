/**
 * Dunning — pure, configurable, phone-first.
 *
 * Which reminder an unpaid invoice gets today, given the console's offsets and
 * what has already been sent. Each step fires once, inside its own window, so a
 * cron that missed a few days does not fire a stack of stale messages:
 *
 *   before due (offsets [30,14,7]):  renewal_30 (14,30]  renewal_14 (7,14]  renewal_7 (0,7]
 *   on the day:                      due_today
 *   after due  (offsets [3,7,12]):   overdue_3 [3,7)     overdue_7 [7,12)   overdue_12 [12,∞)
 *   while suspended:                 cancel_warning at cancel_days − 7
 *
 * `suspended` and `cancelled` are transition messages sent by the runner when
 * the status changes, not date windows. Messages are ≤ 160 GSM-7 characters
 * with the least important clause dropped first, never a truncated URL.
 */
import type { Settings } from './settings-defaults';
import { dayDiff } from './pricing';

export type StepKind = `renewal_${number}` | `overdue_${number}` | 'due_today' | 'suspended' | 'cancel_warning' | 'cancelled';

export interface DunningInvoice {
  id: string;
  kind: 'initial' | 'renewal' | 'addition' | 'upgrade' | 'one_off';
  status: string;
  dueOn: string;
}

export interface DunningSubscription {
  status: string;
  pastDueSince: string | null;
}

export interface DunningInput {
  invoice: DunningInvoice;
  subscription: DunningSubscription | null;
  settings: Pick<Settings, 'collection.reminder_days_before' | 'collection.reminder_days_after' | 'collection.cancel_days'>;
  todayISO: string;
  alreadySent: ReadonlySet<string>;
}

const UNPAID = new Set(['issued', 'part_paid', 'overdue']);
export const CANCEL_WARNING_LEAD_DAYS = 7;

/** The reminder steps due today for one unpaid invoice — usually zero or one. */
export function dunningSteps(i: DunningInput): StepKind[] {
  if (!UNPAID.has(i.invoice.status)) return [];
  const out: StepKind[] = [];
  const daysToDue = dayDiff(i.todayISO, i.invoice.dueOn); // > 0 before due, < 0 overdue
  const sent = i.alreadySent;

  if (daysToDue > 0) {
    const before = [...i.settings['collection.reminder_days_before']].sort((a, b) => b - a);
    for (let k = 0; k < before.length; k++) {
      const d = before[k];
      const lower = before[k + 1] ?? 0;
      const kind: StepKind = `renewal_${d}`;
      if (daysToDue <= d && daysToDue > lower && !sent.has(kind)) out.push(kind);
    }
  } else if (daysToDue === 0) {
    if (!sent.has('due_today')) out.push('due_today');
  } else {
    const overdue = -daysToDue;
    const after = [...i.settings['collection.reminder_days_after']].sort((a, b) => a - b);
    for (let k = 0; k < after.length; k++) {
      const d = after[k];
      const upper = after[k + 1] ?? Number.POSITIVE_INFINITY;
      const kind: StepKind = `overdue_${d}`;
      if (overdue >= d && overdue < upper && !sent.has(kind)) out.push(kind);
    }
  }

  const sub = i.subscription;
  if (sub?.status === 'suspended' && sub.pastDueSince && !sent.has('cancel_warning')) {
    const since = dayDiff(sub.pastDueSince, i.todayISO);
    const warnAt = i.settings['collection.cancel_days'] - CANCEL_WARNING_LEAD_DAYS;
    if (since >= warnAt && since < i.settings['collection.cancel_days']) out.push('cancel_warning');
  }
  return out;
}

export interface MessageContext {
  productName: string;
  /** Registration of the first vehicle, when there is exactly one; else null. */
  registration: string | null;
  vehicles: number;
  /** Formatted amount, e.g. "₦129,000". */
  amount: string;
  /** Formatted date, e.g. "5 Oct 2027". */
  dueOn: string;
  payUrl: string;
  invoiceNumber: string;
  isRenewal: boolean;
  suspendOn?: string | null;
  cancelOn?: string | null;
}

const GSM7 = /^[\x20-\x7e\n]*$/;

function fit(candidates: string[], tail: string): string {
  const found = candidates.map((c) => `${c} ${tail}`.trim()).find((t) => t.length <= 160 && GSM7.test(t));
  if (found) return found;
  const last = candidates[candidates.length - 1];
  return `${last.slice(0, Math.max(0, 157 - tail.length - 1))}... ${tail}`.trim();
}

/** The SMS and email for a step. SMS ≤ 160 GSM-7 with progressive shortening. */
export function stepMessage(step: StepKind, c: MessageContext): { sms: string; subject: string; html: string } {
  const what = c.registration ? `protection for ${c.registration}` : `protection for your ${c.vehicles} vehicles`;
  const thing = c.isRenewal ? what : `invoice ${c.invoiceNumber}`;
  const shortThing = c.isRenewal ? 'protection' : 'invoice';
  const brand = c.productName;
  let candidates: string[];
  let subject: string;

  if (step.startsWith('renewal_')) {
    const days = step.slice('renewal_'.length);
    candidates = c.isRenewal
      ? [
          `${brand}: your ${what} renews on ${c.dueOn} (${days} days). Pay ${c.amount}:`,
          `Your ${what} renews on ${c.dueOn}. Pay ${c.amount}:`,
          `Your protection renews on ${c.dueOn}. Pay:`,
        ]
      : [
          `${brand}: invoice ${c.invoiceNumber} is due on ${c.dueOn}. Pay ${c.amount}:`,
          `Invoice ${c.invoiceNumber} is due on ${c.dueOn}. Pay ${c.amount}:`,
          `Invoice ${c.invoiceNumber} due ${c.dueOn}. Pay:`,
        ];
    subject = c.isRenewal ? `Your ${brand} protection renews on ${c.dueOn}` : `Invoice ${c.invoiceNumber} is due on ${c.dueOn}`;
  } else if (step === 'due_today') {
    candidates = [`${brand}: your ${thing} is due today. Pay ${c.amount} to keep it active:`, `Your ${thing} is due today. Pay ${c.amount}:`, `Your ${shortThing} is due today. Pay:`];
    subject = `${c.isRenewal ? 'Protection' : `Invoice ${c.invoiceNumber}`} due today`;
  } else if (step.startsWith('overdue_')) {
    // The pause date is the fact that changes behaviour; it outlives brand and amount.
    const pause = c.suspendOn ? ` Pauses on ${c.suspendOn}.` : '';
    const head = c.isRenewal ? 'Protection' : `Invoice ${c.invoiceNumber}`;
    candidates = [
      `${brand}: your ${thing} is overdue (${c.amount}).${pause} Pay now:`,
      `Your ${thing} is overdue.${pause} Pay ${c.amount}:`,
      `${head} overdue.${pause} Pay now:`,
      `${head} overdue. Pay now:`,
    ];
    subject = `Overdue: ${c.isRenewal ? 'your protection' : `invoice ${c.invoiceNumber}`}`;
  } else if (step === 'suspended') {
    // The emergency clause outranks everything else here: it is the safety promise.
    candidates = [
      `${brand}: protection is paused for non-payment. Emergencies still reach us. Pay ${c.amount} to resume:`,
      `Protection paused. Emergencies still reach us. Pay to resume:`,
      `Paused. Emergencies still reach us. Pay:`,
    ];
    subject = 'Protection paused — payment required';
  } else if (step === 'cancel_warning') {
    const on = c.cancelOn ? ` on ${c.cancelOn}` : ' soon';
    candidates = [`${brand}: your subscription will be cancelled${on} unless ${c.amount} is paid:`, `Subscription cancelled${on} unless paid:`, `Cancels${on} unless paid:`];
    subject = 'Your subscription will be cancelled';
  } else {
    candidates = [`${brand}: your subscription has been cancelled for non-payment. Start again any time:`, `Subscription cancelled for non-payment. Start again:`];
    subject = 'Subscription cancelled';
  }

  const sms = fit(candidates, c.payUrl);
  const html = `<p>${escapeHtml(candidates[0])}</p><p><a href="${c.payUrl}">${c.payUrl}</a></p>`;
  return { sms, subject, html };
}

/**
 * Money for an SMS: "NGN 25,800,000". The currency symbol (₦) is outside GSM-7
 * and would push the message into UCS-2 and quadruple the segments.
 */
export function asciiMoney(minor: number, currencyCode: string): string {
  const major = Math.round(minor / 100);
  return `${currencyCode} ${major.toLocaleString('en-US')}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
