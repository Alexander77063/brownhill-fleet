// src/lib/admin/audit-filter.ts
// Pure-function parser for the /admin/audit query string. The page reads
// ?entity_type=…&action=…&from=…&to=…&actor=…&limit=… from searchParams
// and calls parseAuditFilter() to coerce them into a typed AuditFilter
// the query layer can turn into SQL. Validation here is what stops a
// malformed URL from putting a `; DROP TABLE` clause into the where.

export interface AuditFilter {
  entityType: string | null;
  action: string | null;
  actorId: string | null;
  from: Date | null;
  to: Date | null;
  limit: number;
}

export type AuditFilterInput = Partial<{
  entity_type: string;
  action: string;
  actor: string;
  from: string;
  to: string;
  limit: string;
}>;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Allow only safe identifiers in entity_type / action. Drop quotes,
// semicolons, spaces, slashes — anything that could either confuse the
// SQL builder or expose an attacker's payload into the log.
const SAFE_NAME_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

function parseDate(s: string | undefined, ceiling: Date | null): Date | null {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (ceiling && d.getTime() > ceiling.getTime()) return ceiling;
  return d;
}

export function parseAuditFilter(input: AuditFilterInput, now: Date): AuditFilter {
  const entityType = input.entity_type && SAFE_NAME_RE.test(input.entity_type) ? input.entity_type : null;
  const action = input.action && SAFE_NAME_RE.test(input.action) ? input.action : null;
  const actorId = input.actor && UUID_RE.test(input.actor) ? input.actor : null;

  const rawFrom = parseDate(input.from, null);
  const rawTo = parseDate(input.to, now);
  let from = rawFrom;
  let to = rawTo;
  if (from && to && from.getTime() > to.getTime()) {
    [from, to] = [to, from];
  }

  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    const n = Number.parseInt(input.limit, 10);
    if (Number.isInteger(n) && n > 0) {
      limit = Math.min(n, MAX_LIMIT);
    }
  }

  return { entityType, action, actorId, from, to, limit };
}