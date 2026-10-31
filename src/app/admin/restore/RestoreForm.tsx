'use client';

// /admin/restore — the form the operator uses to put a dump back.
//
// It is a Client Component because the confirmation is a deliberate act: the
// operator has to pick a dump AND type RESTORE before the button will do
// anything. Everything about the box (the dumps, their sizes, their ages) is
// read on the server and handed over ready-formatted, because the module
// that reads the backup index talks to the filesystem and cannot be bundled
// for the browser.

import { useState } from 'react';
import { Button, Table, Th, Td } from '@/components/ui';

export interface RestoreBackup {
  id: string;
  /** When the dump was taken, written out for a person. */
  taken: string;
  /** The dump's size on disk, written out for a person. */
  size: string;
  /** How long ago the dump was taken. */
  age: string;
}

interface RestoreResponse {
  ok?: boolean;
  started?: boolean;
  backupId?: string;
  startedAt?: string;
  error?: string;
  message?: string;
}

const inputCls =
  'mt-1 w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';
const labelCls = 'eyebrow text-parchment';

export function RestoreForm({ backups }: { backups: RestoreBackup[] }) {
  const [selected, setSelected] = useState<string>(backups[0]?.id ?? '');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreResponse | null>(null);

  // The button stays shut until the operator has both chosen a dump and
  // typed the word. Anything less is not a decision to replace a database.
  const armed = confirmation === 'RESTORE' && selected.length > 0;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!armed) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backupId: selected, confirmation }),
      });
      // The route answers with JSON; a proxy or an auth wall may not, so a
      // body that will not parse must not throw away the status code.
      const body = (await res.json().catch(() => ({}))) as RestoreResponse;
      if (!res.ok || body.ok !== true) {
        if (body.error === 'restoring') {
          setError(
            'A restore is already running on this box. Wait for it to finish, then check the status page.',
          );
          return;
        }
        setError(
          body.message ??
            `The restore could not be started (the server answered ${res.status}). Nothing was changed.`,
        );
        return;
      }
      setResult(body);
      setConfirmation('');
    } catch {
      setError(
        'The application could not be reached, so nothing was started. Check that the server is running and try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <fieldset>
        <legend className={labelCls}>Which backup to restore</legend>
        <Table caption="Backups on this box" className="mt-2">
          <thead>
            <tr>
              <Th scope="col">
                <span className="sr-only">Choose</span>
              </Th>
              <Th scope="col">Taken</Th>
              <Th scope="col">Backup</Th>
              <Th scope="col">Size</Th>
              <Th scope="col">Age</Th>
            </tr>
          </thead>
          <tbody>
            {backups.map((backup) => (
              <tr key={backup.id}>
                <Td>
                  <input
                    type="radio"
                    name="backupId"
                    value={backup.id}
                    checked={selected === backup.id}
                    onChange={() => setSelected(backup.id)}
                    aria-label={`Restore the backup taken ${backup.taken}`}
                    className="accent-[var(--color-gold)]"
                  />
                </Td>
                <Td className="text-cream">{backup.taken}</Td>
                <Td>{backup.id}</Td>
                <Td>{backup.size}</Td>
                <Td>{backup.age}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </fieldset>

      {/* The consequence of the button below, stated where nobody can miss
          it. A restore is not a setting that can be changed back. */}
      <div
        id="restore-warning"
        className="rounded-[var(--radius)] border-2 border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] p-4"
      >
        <p className="text-base font-semibold text-[var(--color-loss)]">
          Restoring replaces the live database.
        </p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-cream">
          <li>
            <span className="font-semibold">Everything written after the dump was taken is lost.</span>{' '}
            A dump taken at 02:00 this morning knows nothing about anything entered since.
          </li>
          <li>
            <span className="font-semibold">The application is stopped while it runs.</span>{' '}
            Everything except this admin area answers &ldquo;unavailable&rdquo; until it is back.
          </li>
          <li>
            <span className="font-semibold">There is no undo.</span> If you choose the wrong
            dump, the only way back is another restore.
          </li>
        </ul>
      </div>

      <div>
        <label className={labelCls} htmlFor="restore-confirmation">
          Type RESTORE to confirm
        </label>
        <input
          id="restore-confirmation"
          name="confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby="restore-warning"
          placeholder="RESTORE"
          className={inputCls}
        />
        <p className="mt-1 text-xs text-muted">
          This is here so that nobody can replace your database by accident.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]"
        >
          {error}
        </p>
      )}

      {result?.ok && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-[var(--color-profit)] bg-[rgba(45,168,98,0.10)] px-3 py-2 text-sm"
        >
          <p className="font-medium text-[var(--color-profit)]">The restore has started.</p>
          <p className="mt-1 text-cream">{result.message}</p>
          <p className="mt-1 text-muted">
            The restore stops the application to replay the database, so this page will stop
            answering for a moment. Watch{' '}
            <a href="/admin/status" className="text-gold-bright underline">
              the status page
            </a>{' '}
            for the outcome.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!armed || pending}>
          {pending ? 'Starting…' : 'Restore this backup'}
        </Button>
        {!armed && (
          <span className="text-xs text-muted">
            {selected.length === 0
              ? 'Choose a backup first.'
              : 'Type RESTORE to enable the button.'}
          </span>
        )}
      </div>
    </form>
  );
}
