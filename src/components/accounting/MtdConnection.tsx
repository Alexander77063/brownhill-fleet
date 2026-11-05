// src/components/accounting/MtdConnection.tsx
// The HMRC MTD connection panel, shared by the two consoles that host it.
//
// It used to be duplicated — once at /accounts/accounting/mtd and once at
// /admin/accounting/mtd — and both copies read `accounting.mtd_credentials`,
// a table migration 0069 renamed to `accounting.firs_credentials`. The
// rename broke both screens with 42P01 ("relation does not exist"), so the
// operator saw an error page instead of their connection status.
//
// One implementation, one place to get the table name right.
//
// THE VAT REGISTRATION NUMBER
// ---------------------------
// A return is filed at `POST /organisations/vat/{vrn}/returns` — the number
// is in the path. The application had nowhere to keep one: no column, no
// field, no way for the operator to say what their VAT registration number
// is. Migration 0084 added the column; this panel is where it is set.
//
// It is NOT the table's `tin`. That is the Nigerian FIRS Tax Identification
// Number — a different country's identifier, on a table that was renamed for
// the Nigerian programme. Filing a UK return against it would file it against
// the wrong organisation.

import { loadCredentialMeta, loadVrnStatus, mtdConfigProblem, readMtdConfig } from '@/lib/accounting/mtd';
import { Button } from '@/components/ui';

export interface MtdConnectionProps {
  /** The tenant whose HMRC connection this panel shows. */
  tenantId: string;
  /** The screen this panel lives on — where the OAuth round trip returns to. */
  returnTo: string;
  /** The `status` query parameter, when the page was reached via a redirect. */
  status?: string | null;
}

/** What the operator is told after an attempt, in plain English. */
function statusMessage(status: string | null | undefined): { tone: 'ok' | 'bad'; text: string } | null {
  if (!status) return null;
  if (status === 'connected') return { tone: 'ok', text: 'Connected to HMRC. The tenant can now file VAT returns.' };
  if (status === 'disconnected') return { tone: 'ok', text: 'Disconnected from HMRC. The stored tokens have been deleted.' };
  if (status === 'not-configured') {
    return {
      tone: 'bad',
      text:
        'This installation cannot make the HMRC connection. Either no HMRC application is registered ' +
        '(set HMRC_MTD_CLIENT_ID and HMRC_MTD_CLIENT_SECRET) or it does not know its own public ' +
        'address (set NEXT_PUBLIC_APP_URL, or HMRC_MTD_REDIRECT_URI). Set them in the app environment, then restart it.',
    };
  }
  if (status === 'invalid-state') {
    return {
      tone: 'bad',
      text: 'The connection request could not be verified, so nothing was saved. It may have expired — please start again.',
    };
  }
  if (status === 'missing-code') {
    return { tone: 'bad', text: 'HMRC did not return an authorisation code. Please start again.' };
  }
  if (status === 'vrn-set') {
    return { tone: 'ok', text: 'The VAT registration number has been saved.' };
  }
  if (status === 'vrn-invalid') {
    return {
      tone: 'bad',
      text:
        'That is not a VAT registration number. A VAT registration number is 3 to 15 digits, ' +
        'with no spaces or letters — check it against the number HMRC issued.',
    };
  }
  if (status === 'vrn-not-connected') {
    return {
      tone: 'bad',
      text:
        'The VAT registration number has not been saved, because this tenant has no HMRC ' +
        'connection to attach it to. Connect to HMRC first, then set the number.',
    };
  }
  if (status === 'vrn-in-use') {
    return {
      tone: 'bad',
      text:
        'That VAT registration number has not been saved, because it is already in use by ' +
        'another tenant on this installation. Each tenant files its own return under its own ' +
        'VAT registration number — check the number HMRC issued to this tenant.',
    };
  }
  if (status.startsWith('denied:')) {
    const reason = status.slice('denied:'.length).replace(/_/g, ' ');
    return { tone: 'bad', text: `HMRC refused the connection (${reason}). Nothing was saved.` };
  }
  if (status.startsWith('error:')) {
    const detail = decodeURIComponent(status.slice('error:'.length));
    return { tone: 'bad', text: `The HMRC connection failed: ${detail}` };
  }
  return null;
}

export default async function MtdConnection({ tenantId, returnTo, status }: MtdConnectionProps) {
  const creds = await loadCredentialMeta(tenantId);
  const config = readMtdConfig();
  const vrnStatus = await loadVrnStatus(tenantId);

  const connectionState = creds
    ? creds.expiresAt.getTime() > Date.now() + 60_000
      ? 'active'
      : 'refresh-needed'
    : 'disconnected';

  const message = statusMessage(status);

  // The VAT registration number the return is filed against — the TENANT'S
  // OWN. The installation's HMRC_MTD_VRN is a default one tenant adopts by
  // saving it here; it is never used behind the tenant's back, and it is not
  // available once another tenant holds it.
  const tenantVrn = vrnStatus.vrn;
  const installVrn = vrnStatus.installVrn;
  const installVrnAvailable = vrnStatus.installVrnAvailable;

  return (
    <>
      {message && (
        <div
          role="status"
          className={
            message.tone === 'ok'
              ? 'mb-4 rounded-[var(--radius)] border border-hair-soft bg-[var(--surface)] p-3 text-sm text-cream'
              : 'mb-4 rounded-[var(--radius)] border border-[var(--color-loss)] p-3 text-sm text-[var(--color-loss)]'
          }
        >
          {message.text}
        </div>
      )}

      <div className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface)] p-4 mb-4">
        <p className="font-semibold text-cream">
          Status:{' '}
          <span
            className={
              connectionState === 'active'
                ? 'text-[var(--color-profit)]'
                : connectionState === 'refresh-needed'
                  ? 'text-[var(--color-warn)]'
                  : 'text-[var(--color-loss)]'
            }
          >
            {connectionState}
          </span>
        </p>
        {creds && (
          <ul className="mt-2 text-sm text-parchment">
            <li>
              MTD client id: <code>{creds.mtdClientId}</code>
            </li>
            <li>
              Redirect URI: <code>{creds.redirectUri}</code>
            </li>
            <li>Token expires: {creds.expiresAt.toISOString()}</li>
          </ul>
        )}
        {!config && (
          <p className="mt-2 text-sm text-parchment">
            {mtdConfigProblem() ?? 'This installation cannot connect to HMRC.'} The Connect button
            cannot complete until it does.
          </p>
        )}
      </div>

      {/* ── the VAT registration number ─────────────────────────────────── */}
      <div className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface)] p-4 mb-4">
        <h2 className="font-semibold text-cream">VAT registration number</h2>
        <p className="mt-1 text-sm text-parchment">
          A VAT return is filed with HMRC at <code>POST /organisations/vat/{'{vrn}'}/returns</code>,
          so this number decides which organisation the return belongs to. It is the number HMRC
          issued — not a tax reference of any other kind.
        </p>

        {tenantVrn ? (
          <p className="mt-2 text-sm text-cream">
            Currently filed at: <span className="font-mono">{tenantVrn}</span>{' '}
            <span className="text-muted">(set for this tenant)</span>
          </p>
        ) : installVrn && installVrnAvailable ? (
          <p className="mt-2 text-sm text-cream">
            This installation is configured with the VAT registration number{' '}
            <span className="font-mono">{installVrn}</span>.{' '}
            <span className="text-muted">
              Save it below to file this tenant&apos;s returns under it. A return is always filed
              under the tenant&apos;s own number, and each tenant files under its own.
            </span>
          </p>
        ) : installVrn ? (
          <p className="mt-2 text-sm text-[var(--color-warn)]">
            The installation&apos;s VAT registration number{' '}
            <span className="font-mono">{installVrn}</span> is already in use by another tenant on
            this installation, so it cannot be used here. Type this tenant&apos;s own VAT
            registration number below.
          </p>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-warn)]">
            No VAT registration number is set, so a VAT return cannot be filed for this tenant.
          </p>
        )}

        {creds ? (
          <form action="/api/v1/accounting/mtd/vrn" method="post" className="mt-3">
            <input type="hidden" name="returnTo" value={returnTo} />
            <label htmlFor="vrn" className="block text-sm text-cream">
              VAT registration number
            </label>
            <input
              id="vrn"
              name="vrn"
              inputMode="numeric"
              autoComplete="off"
              defaultValue={tenantVrn ?? (installVrnAvailable ? (installVrn ?? '') : '')}
              placeholder="123456789"
              aria-describedby="vrn-help"
              className="mt-1 w-full max-w-xs rounded-[var(--radius)] border border-hair-soft bg-ink px-3 py-2 text-sm text-cream"
            />
            <p id="vrn-help" className="mt-1 text-sm text-muted">
              3 to 15 digits, with no spaces or letters. Clear the box to remove the number.
            </p>
            <Button type="submit" variant="outline" size="sm" className="mt-3">
              Save the VAT registration number
            </Button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Connect to HMRC first — the VAT registration number is kept on the HMRC connection.
          </p>
        )}
      </div>

      <form action="/api/v1/accounting/mtd/connect" method="get">
        <input type="hidden" name="returnTo" value={returnTo} />
        <Button type="submit" variant="primary" size="md">
          {connectionState === 'disconnected' ? 'Connect to HMRC' : 'Reconnect to HMRC'}
        </Button>
      </form>

      {connectionState !== 'disconnected' && (
        <form action="/api/v1/accounting/mtd/disconnect" method="post" className="mt-2">
          <input type="hidden" name="returnTo" value={returnTo} />
          <Button type="submit" variant="ghost" size="sm">
            Disconnect
          </Button>
        </form>
      )}
    </>
  );
}
