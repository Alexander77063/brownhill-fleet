// src/components/LastRestore.tsx — what the box knows about the last restore.
//
// Shared by /admin/restore and /admin/status so the two pages cannot tell
// the operator two different stories about the same attempt.
//
// The outcome is recorded in a file beside the application rather than in the
// database, because a restore REPLAYS the database — anything written to it
// before the restore is rolled back with it.

import { Card, CardTitle, Badge } from '@/components/ui';
import { formatTimestamp } from '@/lib/backup/index-file';
import type { RestoreRecord } from '@/lib/backup/restore';

export function LastRestore({ record }: { record: RestoreRecord | null }) {
  if (!record) {
    return (
      <Card>
        <CardTitle>Last restore</CardTitle>
        <p className="mt-1 text-sm text-muted">
          No restore has been run on this box. When one is, what happened and what to do next
          is written here.
        </p>
      </Card>
    );
  }

  if (record.state === 'started') {
    return (
      <Card className="border-[var(--color-warn)]">
        <div className="flex items-center gap-2">
          <Badge tone="warn">No outcome recorded</Badge>
          <CardTitle>A restore of {record.backupId} was started</CardTitle>
        </div>
        <p className="mt-2 text-sm text-muted">
          It was started at {formatTimestamp(record.startedAt)} and the box never recorded how
          it ended. That is expected if the restore stopped the application: the restore
          script shuts the application down to replay the database, so the application
          cannot write the ending down. If the application is serving now, the restore
          finished. If it is not, read the journal (
          <code className="text-parchment">journalctl -u brownhill-next -n 100</code>) to see
          where it stopped.
        </p>
      </Card>
    );
  }

  const outcome = record.outcome;
  return (
    <Card
      className={
        record.state === 'succeeded'
          ? 'border-[var(--color-profit)]'
          : 'border-[var(--color-loss)]'
      }
    >
      <div className="flex items-center gap-2">
        <Badge tone={record.state === 'succeeded' ? 'profit' : 'loss'}>
          {record.state === 'succeeded' ? 'Succeeded' : 'Failed'}
        </Badge>
        <CardTitle>
          Restore of {record.backupId}, {formatTimestamp(record.startedAt)}
        </CardTitle>
      </div>
      {outcome && (
        <>
          <p className="mt-2 text-sm text-cream">{outcome.summary}</p>
          <p className="mt-1 text-sm text-muted">{outcome.nextStep}</p>
        </>
      )}
    </Card>
  );
}
