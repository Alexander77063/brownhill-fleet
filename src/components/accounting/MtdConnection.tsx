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

import { loadCredentialMeta, readMtdConfig } from '@/lib/accounting/mtd';

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
        'This installation has no HMRC application registered, so the connection cannot be made. ' +
        'Set HMRC_MTD_CLIENT_ID, HMRC_MTD_CLIENT_SECRET and HMRC_MTD_REDIRECT_URI in the app environment, then restart it.',
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

  const connectionState = creds
    ? creds.expiresAt.getTime() > Date.now() + 60_000
      ? 'active'
      : 'refresh-needed'
    : 'disconnected';

  const message = statusMessage(status);

  return (
    <>
      {message && (
        <div
          role="status"
          className={
            message.tone === 'ok'
              ? 'mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900'
              : 'mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900'
          }
        >
          {message.text}
        </div>
      )}

      <div className="border rounded p-4 mb-4">
        <p className="font-semibold">
          Status:{' '}
          <span
            className={
              connectionState === 'active'
                ? 'text-green-600'
                : connectionState === 'refresh-needed'
                  ? 'text-yellow-600'
                  : 'text-red-600'
            }
          >
            {connectionState}
          </span>
        </p>
        {creds && (
          <ul className="text-sm mt-2 text-gray-700">
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
          <p className="text-sm mt-2 text-gray-700">
            No HMRC application is registered on this installation, so the Connect button cannot complete. Ask
            whoever runs the server to set <code>HMRC_MTD_CLIENT_ID</code> and <code>HMRC_MTD_CLIENT_SECRET</code>.
          </p>
        )}
      </div>

      <form action="/api/v1/accounting/mtd/connect" method="get">
        <input type="hidden" name="returnTo" value={returnTo} />
        <button className="px-4 py-2 bg-blue-600 text-white rounded">
          {connectionState === 'disconnected' ? 'Connect to HMRC' : 'Reconnect to HMRC'}
        </button>
      </form>

      {connectionState !== 'disconnected' && (
        <form action="/api/v1/accounting/mtd/disconnect" method="post" className="mt-2">
          <input type="hidden" name="returnTo" value={returnTo} />
          <button className="px-4 py-2 bg-red-100 text-red-700 rounded">Disconnect</button>
        </form>
      )}
    </>
  );
}
