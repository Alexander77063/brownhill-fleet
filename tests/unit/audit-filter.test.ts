// tests/unit/audit-filter.test.ts
// Pure-function tests for the audit-log filter parsing. The /admin/audit
// page reads entity_type / action / from / to from searchParams and passes
// them to listAuditEntries() as a typed filter. The query layer builds
// the SQL from this filter; these tests pin the parsing so a malformed
// URL doesn't silently mean "show everything" (or, worse, an unsafe one).

import { describe, expect, it } from 'vitest';
import {
  parseAuditFilter,
  type AuditFilterInput,
} from '@/lib/admin/audit-filter';

const NOW = new Date('2026-09-15T12:00:00Z');

describe('parseAuditFilter', () => {
  it('returns a clean filter when no inputs are given', () => {
    expect(parseAuditFilter({}, NOW)).toEqual({
      entityType: null,
      action: null,
      actorId: null,
      from: null,
      to: null,
      limit: 100,
    });
  });

  it('keeps an allowed entity_type verbatim', () => {
    const f = parseAuditFilter({ entity_type: 'payment' }, NOW);
    expect(f.entityType).toBe('payment');
  });

  it('rejects an unknown entity_type', () => {
    const f = parseAuditFilter({ entity_type: "'; DROP TABLE--" }, NOW);
    expect(f.entityType).toBeNull();
  });

  it('caps the limit at 500', () => {
    const f = parseAuditFilter({ limit: '9999' }, NOW);
    expect(f.limit).toBe(500);
  });

  it('treats a negative limit as the default', () => {
    const f = parseAuditFilter({ limit: '-1' }, NOW);
    expect(f.limit).toBe(100);
  });

  it('parses an ISO date in `from`', () => {
    const f = parseAuditFilter({ from: '2026-09-01' }, NOW);
    expect(f.from?.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('ignores a malformed `from` date', () => {
    const f = parseAuditFilter({ from: 'not-a-date' }, NOW);
    expect(f.from).toBeNull();
  });

  it('clamps `to` to now if the caller asks for the future', () => {
    const f = parseAuditFilter({ to: '2099-12-31' }, NOW);
    expect(f.to?.toISOString()).toBe(NOW.toISOString());
  });

  it('swaps `from` and `to` if the user gave them reversed', () => {
    const f = parseAuditFilter({ from: '2026-09-10', to: '2026-09-01' }, NOW);
    expect(f.from?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(f.to?.toISOString().slice(0, 10)).toBe('2026-09-10');
  });

  it('keeps an action that looks like a dotted path', () => {
    const f = parseAuditFilter({ action: 'agreement.signed' }, NOW);
    expect(f.action).toBe('agreement.signed');
  });

  it('rejects an action containing a quote or semicolon', () => {
    const f = parseAuditFilter({ action: "payment';--" }, NOW);
    expect(f.action).toBeNull();
  });

  it('keeps a valid uuid in actor', () => {
    const f = parseAuditFilter({ actor: '11111111-2222-3333-4444-555555555555' }, NOW);
    expect(f.actorId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('rejects a malformed uuid in actor', () => {
    const f = parseAuditFilter({ actor: 'not-a-uuid' }, NOW);
    expect(f.actorId).toBeNull();
  });
});