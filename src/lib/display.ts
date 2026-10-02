// Small presentation helpers shared across pages.

export function formatDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function daysUntil(d: string | null | undefined): number | null {
  if (!d) return null;
  const ms = new Date(d).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

export function titleCase(s: string | null | undefined): string {
  // Null-safe like formatDate/daysUntil: nullable DB-view fields (e.g. gfv_status
  // via a LEFT JOIN) arrive as undefined and must not throw on .replace().
  return (s ?? '—').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

type Tone = 'neutral' | 'gold' | 'profit' | 'loss' | 'warn' | 'info';

export function vehicleStatusTone(s: string): Tone {
  return { available: 'info', on_hire: 'profit', off_road: 'warn', sold: 'neutral' }[s] as Tone ?? 'neutral';
}
export function driverStatusTone(s: string): Tone {
  return { active: 'profit', vetting: 'warn', lead: 'info', suspended: 'loss', terminated: 'neutral' }[s] as Tone ?? 'neutral';
}
export function agreementStatusTone(s: string): Tone {
  return {
    active: 'profit', draft: 'neutral', pending_signature: 'warn',
    ended: 'neutral', defaulted: 'loss', transferred: 'gold',
  }[s] as Tone ?? 'neutral';
}
export function severityTone(s: string): Tone {
  return { info: 'info', warning: 'warn', critical: 'loss' }[s] as Tone ?? 'neutral';
}
export function invoiceStatusTone(s: string): Tone {
  return { paid: 'profit', open: 'neutral', part_paid: 'warn', overdue: 'loss', void: 'neutral' }[s] as Tone ?? 'neutral';
}
export function chargeStatusTone(s: string): Tone {
  return {
    received: 'warn', driver_notified: 'info', driver_liable: 'gold', disputed: 'warn',
    paid_by_driver: 'profit', paid_by_company: 'loss', cancelled: 'neutral',
  }[s] as Tone ?? 'neutral';
}
export function gfvTone(s: string): Tone {
  return { confirmed: 'profit', unconfirmed: 'warn', settled: 'gold', na: 'neutral' }[s] as Tone ?? 'neutral';
}

/** "just now", "3 minutes ago", "2 hours ago", "yesterday", "4 days ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
