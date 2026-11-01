// src/app/admin/status/page.tsx — is this box healthy?
//
// The handoff tells the operator to check this page when something is wrong.
// It answers four questions: is the newest backup recent, did the off-host
// copy succeed, is the application closed for a restore, and how long has the
// application been up.
//
// Every fact is read directly — the backup index and the sync state from the
// filesystem, the drain flag from the database. Nothing here fetches the
// application's own origin: a server component that fetched itself would
// deadlock on a single-threaded server, and the facts it needs are not behind
// HTTP anyway.
import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Badge, Button, Stat } from '@/components/ui';
import { LastRestore } from '@/components/LastRestore';
import { readSessionClaims } from '@/lib/auth/local-session';
import { deploymentProfile } from '@/lib/deployment/profile';
import { STATUS_ALERT_TEXT, collectBoxStatus } from '@/lib/backup/status';
import { formatAge, formatBytes, formatTimestamp } from '@/lib/backup/index-file';

export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  // The operator status surface exists only on a box the customer operates.
  // On every other profile it does not exist: the API answers 404 there, and
  // the page must not be the one place that leaks it.
  if (!deploymentProfile().customerOps) notFound();

  // The same check the API makes, so the page and the JSON cannot disagree
  // about who is allowed to see the box.
  const claims = await readSessionClaims();
  if (claims?.role !== 'owner') {
    return (
      <Wrap>
        <PageHeader eyebrow="Operator" title="Box status" />
        <Card>
          <p className="text-sm text-muted">
            Only the organisation owner can see the box status. Sign in as the owner and try
            again.
          </p>
        </Card>
      </Wrap>
    );
  }

  const status = await collectBoxStatus();

  return (
    <Wrap>
      <PageHeader
        eyebrow="Operator"
        title="Box status"
        subtitle="Is this box taking its backups, getting them off the machine, and serving?"
        actions={<Button href="/admin/restore" variant="outline" size="sm">Restore a backup</Button>}
      />

      {!status.databaseReachable && (
        <Card className="mb-4 border-[var(--color-loss)]">
          <div className="flex items-center gap-2">
            <Badge tone="loss">Database unreachable</Badge>
            <CardTitle>This page cannot see the database</CardTitle>
          </div>
          <p className="mt-2 text-sm text-muted">
            The drain flag could not be read, so whether the application is closed for a
            restore is unknown.{' '}
            {status.databaseError ? (
              <>
                The database said:{' '}
                <code className="text-parchment">{status.databaseError}</code>
              </>
            ) : null}
          </p>
        </Card>
      )}

      {status.alerts.length > 0 && (
        <section className="mb-4 space-y-3">
          {status.alerts.map((alert) => {
            const text = STATUS_ALERT_TEXT[alert];
            return (
              <Card key={alert} className="border-[var(--color-warn)]">
                <div className="flex items-center gap-2">
                  <Badge tone="warn">Attention</Badge>
                  <CardTitle>{text.title}</CardTitle>
                </div>
                <p className="mt-2 text-sm text-cream">{text.detail}</p>
                <p className="mt-1 text-sm text-muted">{text.action}</p>
              </Card>
            );
          })}
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Newest backup"
          value={status.backup ? formatAge(status.lastBackupAge) : 'Never'}
          tone={status.lastBackupAge !== null && status.alerts.includes('backup_stale') ? 'warn' : 'default'}
          hint={
            status.backup
              ? `Taken ${formatTimestamp(status.backup.ts)} · ${formatBytes(status.backup.size)}`
              : 'The nightly job writes a dump at 02:00 and records it here.'
          }
        />
        <Stat
          label="Off-host copy"
          value={
            !status.sync ? 'Not yet' : status.sync.ok ? 'Copied' : 'Failed'
          }
          tone={status.sync ? (status.sync.ok ? 'profit' : 'loss') : 'default'}
          hint={
            !status.sync
              ? 'No off-host copy has been recorded yet.'
              : status.sync.ok
                ? `Copied ${status.sync.at ? formatTimestamp(status.sync.at) : ''}${
                    status.sync.target ? ` to ${status.sync.target}` : ''
                  }`
                : `Last tried ${status.sync.at ? formatTimestamp(status.sync.at) : 'unknown'}${
                    status.sync.detail ? ` — ${status.sync.detail}` : ''
                  }`
          }
        />
        <Stat
          label="Application"
          value={status.restoring ? 'Closed' : 'Serving'}
          tone={status.restoring ? 'warn' : 'profit'}
          hint={
            status.restoring
              ? 'Closed for a restore. Everything except /admin/* answers 503.'
              : 'Serving normally.'
          }
        />
        <Stat
          label="Uptime"
          value={formatUptime(status.uptime)}
          hint="Since the last restart of the application."
        />
      </section>

      {status.backupIndex !== 'ok' && (
        <Card className="mt-4">
          <CardTitle>About the backup list</CardTitle>
          <p className="mt-1 text-sm text-muted">{BACKUP_INDEX_TEXT[status.backupIndex]}</p>
        </Card>
      )}

      <section className="mt-6">
        <LastRestore record={status.lastRestore} />
      </section>
    </Wrap>
  );
}

/**
 * What the state of the backup index means for the operator.
 *
 * None of these are emergencies on a box that has just been installed, so
 * none of them is dressed up as one.
 */
const BACKUP_INDEX_TEXT: Record<string, string> = {
  missing:
    'This box has not taken a backup yet. The nightly job writes the first one at 02:00 — check the backup journal (journalctl -u brownhill-backup -n 100) if it has not appeared.',
  unreadable:
    'The backup index exists but could not be opened. The application account needs to be able to read /var/backups/brownhill; on the box that directory is owned by the shared service group.',
  corrupt:
    'The backup index is not valid JSON — it was probably half-written when the box lost power. The dumps themselves may still be there; restore from the console if you need one.',
};

/** How long the application has been up, in words. */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>;
}
