// src/app/admin/accounting/mtd/page.tsx
// Owner-only HMRC MTD connection settings + token-status display.

import { localDb } from '@/lib/auth/local-store';

interface CredRow {
  mtd_client_id: string;
  redirect_uri: string;
  token_expires_at: string;
}

async function loadCreds(): Promise<CredRow | null> {
  const sql = await localDb();
  const rows = (await sql`
    select mtd_client_id, redirect_uri, token_expires_at::text
      from accounting.mtd_credentials limit 1
  `) as Array<CredRow>;
  return rows[0] ?? null;
}

export default async function MtdSettingsPage() {
  const creds = await loadCreds();
  const status = creds
    ? new Date(creds.token_expires_at) > new Date(Date.now() + 60_000)
      ? 'active'
      : 'refresh-needed'
    : 'disconnected';
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">HMRC MTD connection</h1>
      <div className="border rounded p-4 mb-4">
        <p className="font-semibold">Status: <span className={
          status === 'active' ? 'text-green-600' : status === 'refresh-needed' ? 'text-yellow-600' : 'text-red-600'
        }>{status}</span></p>
        {creds && (
          <ul className="text-sm mt-2 text-gray-700">
            <li>MTD client id: <code>{creds.mtd_client_id}</code></li>
            <li>Redirect URI: <code>{creds.redirect_uri}</code></li>
            <li>Token expires: {creds.token_expires_at}</li>
          </ul>
        )}
      </div>
      <form action="/api/v1/accounting/mtd/connect" method="get">
        <button className="px-4 py-2 bg-blue-600 text-white rounded">
          {status === 'disconnected' ? 'Connect to HMRC' : 'Reconnect to HMRC'}
        </button>
      </form>
      {status !== 'disconnected' && (
        <form action="/api/v1/accounting/mtd/disconnect" method="post" className="mt-2">
          <button className="px-4 py-2 bg-red-100 text-red-700 rounded">Disconnect</button>
        </form>
      )}
    </main>
  );
}
