// src/app/admin/audit/page.tsx
// Owner-only audit log viewer. Records every sensitive action the app
// performs (member changes, payment link sends, damage status transitions,
// booking series creation) so there's a tamper-evident history of "who
// did what". The underlying audit_log table is append-only via log_audit().
//
// Permission: requirePermission('tenant.settings') — same gate as /admin/members
// and the other owner-only surfaces. RLS at the table level is a second
// check on top.

import { PageHeader, Card, CardTitle, EmptyState, Badge, Button } from '@/components/ui';
import { requirePermission } from '@/lib/auth/context';
import { listAuditEntries, listAuditFacets } from '@/lib/queries-audit';
import { parseAuditFilter } from '@/lib/admin/audit-filter';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

function fmtDetail(detail: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) return '—';
  const entries = Object.entries(detail).slice(0, 6);
  return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    entity_type?: string;
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    limit?: string;
  }>;
}) {
  await requirePermission('tenant.settings');

  const sp = await searchParams;
  const filter = parseAuditFilter(sp, new Date());
  const [entries, facets] = await Promise.all([
    listAuditEntries(filter),
    listAuditFacets(),
  ]);

  return (
    <main className="p-6">
      <div className="mb-2 text-xs uppercase tracking-wider text-muted">
        <a href="/admin" className="hover:text-cream">← Admin</a>
      </div>
      <PageHeader
        eyebrow="Admin"
        title="Audit log"
        subtitle="Every sensitive action the office has performed. Append-only — nothing in this list can be edited or deleted from the UI."
      />

      <Card className="mt-4">
        <CardTitle>Filter</CardTitle>
        <form method="get" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <label className="block">
            <span className="eyebrow text-parchment">Entity</span>
            <select name="entity_type" defaultValue={sp.entity_type ?? ''} className={`${inputCls} mt-1 w-full`}>
              <option value="">All</option>
              {facets.entityTypes.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow text-parchment">Action</span>
            <select name="action" defaultValue={sp.action ?? ''} className={`${inputCls} mt-1 w-full`}>
              <option value="">All</option>
              {facets.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow text-parchment">From</span>
            <input type="date" name="from" defaultValue={sp.from ?? ''} className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="block">
            <span className="eyebrow text-parchment">To</span>
            <input type="date" name="to" defaultValue={sp.to ?? ''} className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="block">
            <span className="eyebrow text-parchment">Limit</span>
            <input type="number" name="limit" min={1} max={500} defaultValue={sp.limit ?? '100'} className={`${inputCls} mt-1 w-full`} />
          </label>
          <div className="flex items-end">
            <Button type="submit" variant="outline" size="sm" className="w-full">Apply</Button>
          </div>
        </form>
      </Card>

      <section className="mt-5">
        {entries.length === 0 ? (
          <EmptyState
            title="No audit events match"
            hint="Either nothing has happened in this window, or the actions weren't recorded yet. New actions get wired up over time."
          />
        ) : (
          <ul className="space-y-2">
            {entries.map((e) => (
              <li key={e.id} className="rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-muted">{new Date(e.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</span>
                  <Badge tone="neutral">{e.action}</Badge>
                  {e.entityType && <Badge tone="neutral">{e.entityType}</Badge>}
                  <span className="ml-auto text-muted">{e.actorEmail ?? e.actorId ?? 'system'}</span>
                </div>
                {Object.keys(e.detail).length > 0 && (
                  <p className="mt-2 break-words text-xs text-muted">{fmtDetail(e.detail)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}