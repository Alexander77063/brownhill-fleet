// src/lib/driver/damage-report-status.ts
// Pure-function rules for the driver_damage_reports state machine. Lives
// here so both /driver/report (which only inserts new rows in 'open')
// and /ops/incidents (which mutates status on existing rows) share the
// same allowed-transition rule. Without a single source of truth the two
// surfaces drift apart — the ops dashboard shows a button the action
// rejects, or accepts a transition the dashboard never rendered.

export type DamageSeverity = 'minor' | 'moderate' | 'major';

export const SEVERITIES: ReadonlyArray<DamageSeverity> = ['minor', 'moderate', 'major'];

export function isValidSeverity(s: string): s is DamageSeverity {
  return SEVERITIES.includes(s as DamageSeverity);
}

export type DamageReportStatus = 'open' | 'reviewed' | 'in_repair' | 'resolved' | 'rejected';

/** Terminal statuses — no further transitions allowed. */
const TERMINAL: ReadonlyArray<DamageReportStatus> = ['resolved', 'rejected'];

/** Forward edges of the state machine. Backwards / same-state / skips are rejected. */
const FORWARD: Record<Exclude<DamageReportStatus, 'resolved' | 'rejected'>, ReadonlyArray<DamageReportStatus>> = {
  open:       ['reviewed', 'rejected'],
  reviewed:   ['in_repair', 'rejected'],
  in_repair:  ['resolved', 'rejected'],
};

export function isValidTransition(from: DamageReportStatus, to: DamageReportStatus): boolean {
  if (from === to) return false;
  if (TERMINAL.includes(from)) return false;
  return FORWARD[from as Exclude<DamageReportStatus, 'resolved' | 'rejected'>].includes(to);
}

export function nextAllowedStatuses(from: DamageReportStatus): ReadonlyArray<DamageReportStatus> {
  if (TERMINAL.includes(from)) return [];
  return [...FORWARD[from as Exclude<DamageReportStatus, 'resolved' | 'rejected'>]];
}