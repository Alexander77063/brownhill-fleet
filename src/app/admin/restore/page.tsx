// src/app/admin/restore/page.tsx — the operator's restore console.
//
// The customer handoff promises the operator that they can sign in and put a
// dump back from the browser. This is that page. It reads the same index the
// API reads (through the one reader in src/lib/backup/index-file.ts) and it
// never fetches the application's own origin: every fact on it comes from
// the filesystem and the database, read directly on the server.
import { notFound } from 'next/navigation';
import { PageHeader, Card, CardTitle, Badge, Button, EmptyState } from '@/components/ui';
import { LastRestore } from '@/components/LastRestore';
import { readSessionClaims } from '@/lib/auth/local-session';
import { deploymentProfile } from '@/lib/deployment/profile';
import {
  backupAgeSeconds,
  formatAge,
  formatBytes,
  formatTimestamp,
  readBackupIndex,
  sortBackups,
} from '@/lib/backup/index-file';
import { readRestoreRecord } from '@/lib/backup/restore';
import { RestoreForm } from './RestoreForm';

export const dynamic = 'force-dynamic';

export default async function RestorePage() {
  // The restore console drives the backup service on the customer's own box.
  // On every other profile it does not exist: the API answers 404 there, and
  // a page that offered the button would be a page offering a dead end.
  if (!deploymentProfile().customerOps) notFound();

  // The same check the API makes: the restore console belongs to the tenant
  // owner, and a page that offers a button the API will refuse is worse than
  // no page at all.
  const claims = await readSessionClaims();
  if (claims?.role !== 'owner') {
    return (
      <Wrap>
        <PageHeader eyebrow="Operator" title="Restore from a backup" />
        <Card>
          <p className="text-sm text-muted">
            Only the organisation owner can restore a backup. Sign in as the owner and try again.
          </p>
        </Card>
      </Wrap>
    );
  }

  const index = readBackupIndex();
  const backups = sortBackups(index.entries).map((entry) => ({
    id: entry.id,
    taken: formatTimestamp(entry.ts),
    size: formatBytes(entry.size),
    age: formatAge(backupAgeSeconds(entry)),
  }));

  const record = readRestoreRecord();

  return (
    <Wrap>
      <PageHeader
        eyebrow="Operator"
        title="Restore from a backup"
        subtitle="Put a nightly dump back onto the live database. This replaces everything the business has entered since the dump was taken, so read the warning before you start."
        actions={<Button href="/admin/status" variant="outline" size="sm">Box status</Button>}
      />

      {index.state === 'unreadable' && (
        <Card className="mb-4 border-[var(--color-warn)]">
          <div className="flex items-center gap-2">
            <Badge tone="warn">Cannot read</Badge>
            <CardTitle>The backup index could not be read</CardTitle>
          </div>
          <p className="mt-2 text-sm text-muted">
            The box found <code className="text-parchment">/var/backups/brownhill/_index.json</code>{' '}
            but could not open it. The application account needs to be able to read that
            directory. On the box that is a group permission on{' '}
            <code className="text-parchment">/var/backups/brownhill</code> — the shared
            service group owns it.
          </p>
        </Card>
      )}

      {index.state === 'corrupt' && (
        <Card className="mb-4 border-[var(--color-warn)]">
          <div className="flex items-center gap-2">
            <Badge tone="warn">Damaged</Badge>
            <CardTitle>The backup index is not readable JSON</CardTitle>
          </div>
          <p className="mt-2 text-sm text-muted">
            The file exists but does not parse — it was probably half-written when the box
            lost power. The dumps themselves may still be there. Read the backup journal
            (<code className="text-parchment">journalctl -u brownhill-backup -n 100</code>)
            and restore from the console if you need to.
          </p>
        </Card>
      )}

      {backups.length === 0 ? (
        <EmptyState
          title="This box has no backups yet"
          hint="The nightly job writes a dump at 02:00 and records it here. If the box has only just been installed, wait for the first one — or check the backup journal (journalctl -u brownhill-backup -n 100)."
        />
      ) : (
        <Card>
          <CardTitle>Restore a backup</CardTitle>
          <p className="mt-1 text-sm text-muted">
            {backups.length} dump{backups.length === 1 ? '' : 's'} on this box. The newest is{' '}
            {backups[0].age}.
          </p>
          <div className="mt-4">
            <RestoreForm backups={backups} />
          </div>
        </Card>
      )}

      <section className="mt-6">
        <LastRestore record={record} />
      </section>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>;
}
