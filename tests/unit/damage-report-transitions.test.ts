// tests/unit/damage-report-transitions.test.ts
// Pure-function tests for the status state machine on driver_damage_reports.
// Lives in @/lib/driver/damage-report-status so the driver-side submit
// validation and the ops-side action both share the rule. Without a single
// source of truth, drivers and ops end up with a button in one view that's
// not allowed in the other — and worse, with no test that pins the rule.

import { describe, expect, it } from 'vitest';
import {
  type DamageReportStatus,
  type DamageSeverity,
  isValidTransition,
  nextAllowedStatuses,
  isValidSeverity,
} from '@/lib/driver/damage-report-status';

describe('isValidSeverity', () => {
  it('accepts the three documented severities', () => {
    expect(isValidSeverity('minor')).toBe(true);
    expect(isValidSeverity('moderate')).toBe(true);
    expect(isValidSeverity('major')).toBe(true);
  });
  it('rejects unknown severities', () => {
    expect(isValidSeverity('catastrophic' as DamageSeverity)).toBe(false);
    expect(isValidSeverity('' as DamageSeverity)).toBe(false);
  });
});

describe('isValidTransition', () => {
  it('open -> reviewed is allowed', () => {
    expect(isValidTransition('open', 'reviewed')).toBe(true);
  });
  it('reviewed -> in_repair is allowed', () => {
    expect(isValidTransition('reviewed', 'in_repair')).toBe(true);
  });
  it('in_repair -> resolved is allowed', () => {
    expect(isValidTransition('in_repair', 'resolved')).toBe(true);
  });
  it('any non-terminal status -> rejected is allowed', () => {
    expect(isValidTransition('open', 'rejected')).toBe(true);
    expect(isValidTransition('reviewed', 'rejected')).toBe(true);
    expect(isValidTransition('in_repair', 'rejected')).toBe(true);
  });
  it('terminal statuses have no allowed moves', () => {
    const terminals: ReadonlyArray<DamageReportStatus> = ['resolved', 'rejected'];
    const all: ReadonlyArray<DamageReportStatus> = ['open', 'reviewed', 'in_repair', 'resolved', 'rejected'];
    for (const t of terminals) {
      for (const target of all) {
        expect(isValidTransition(t, target)).toBe(false);
      }
    }
  });
  it('rejects skipping ahead (open -> in_repair)', () => {
    expect(isValidTransition('open', 'in_repair')).toBe(false);
  });
  it('rejects backwards (reviewed -> open)', () => {
    expect(isValidTransition('reviewed', 'open')).toBe(false);
  });
  it('rejects same-state (open -> open)', () => {
    expect(isValidTransition('open', 'open')).toBe(false);
  });
});

describe('nextAllowedStatuses', () => {
  it('from open returns [reviewed, rejected]', () => {
    expect([...nextAllowedStatuses('open')].sort()).toEqual(['rejected', 'reviewed']);
  });
  it('from reviewed returns [in_repair, rejected]', () => {
    expect([...nextAllowedStatuses('reviewed')].sort()).toEqual(['in_repair', 'rejected']);
  });
  it('from in_repair returns [resolved, rejected]', () => {
    expect([...nextAllowedStatuses('in_repair')].sort()).toEqual(['rejected', 'resolved']);
  });
  it('from a terminal status returns an empty array', () => {
    expect(nextAllowedStatuses('resolved')).toEqual([]);
    expect(nextAllowedStatuses('rejected')).toEqual([]);
  });
});