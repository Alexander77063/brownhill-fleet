// src/app/[tenant]/admin/accounting/banks/page.tsx
import { localDb } from '@/lib/auth/local-store';
import { listBankFormats } from '@/lib/accounting/nigeria/bank-formats';

async function loadBanks() {
  const sql = await localDb();
  return (await sql`
    select ba.id, ba.name, ba.sort_code, ba.account_number, ba.iban, ba.format_name,
           coa.code as gl_account_code
      from accounting.bank_accounts ba
      join accounting.chart_of_accounts coa on coa.id = ba.gl_account_id
     order by ba.name
  `) as Array<{
    id: string; name: string; sort_code: string | null;
    account_number: string | null; iban: string | null;
    format_name: string; gl_account_code: string;
  }>;
}

export default async function BanksPage() {
  const rows = await loadBanks();
  const formats = await listBankFormats();
  const builtinFormats = ['GTBank', 'Zenith', 'Access', 'UBA'];
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Bank accounts</h1>

      <details className="mb-4 border rounded p-3">
        <summary className="cursor-pointer font-semibold">Register a custom bank format</summary>
        <form action="/api/v1/accounting/banks/formats" method="post" className="grid grid-cols-2 gap-2 mt-2">
          <input name="name" placeholder="format name (e.g. Ecobank Nigeria)" className="border p-2" required />
          <input name="date_format" placeholder="DD/MM/YYYY" defaultValue="DD/MM/YYYY" className="border p-2" required />
          <input name="amount_format" placeholder="signed-pence" defaultValue="signed-pence" className="border p-2" required />
          <textarea
            name="column_mapping"
            placeholder='{"date":"Trans Date","description":"Narration","debit":"Debit","credit":"Credit"}'
            className="border p-2 col-span-2"
            rows={4}
            required
          />
          <button className="col-span-2 px-4 py-2 bg-blue-600 text-white rounded">Register format</button>
        </form>
      </details>

      <form action="/api/v1/accounting/banks" method="post" className="mb-4 grid grid-cols-5 gap-2">
        <input name="name" placeholder="account name" className="border p-2" required />
        <input name="sort_code" placeholder="sort code" className="border p-2" />
        <input name="account_number" placeholder="account no." className="border p-2" />
        <input name="iban" placeholder="IBAN" className="border p-2" />
        <select name="format_name" className="border p-2" required>
          <option value="">-- format --</option>
          {builtinFormats.map(f => <option key={f} value={f}>{f}</option>)}
          {formats.map(f => <option key={f.name} value={f.name}>{f.name} (custom)</option>)}
        </select>
        <input type="hidden" name="_action" value="add" />
        <button className="col-span-5 px-4 py-2 bg-blue-600 text-white rounded">Add bank account</button>
      </form>

      <table className="min-w-full border">
        <thead>
          <tr>
            <th className="text-left p-2">Name</th>
            <th className="text-left p-2">Sort code</th>
            <th className="text-left p-2">Account no.</th>
            <th className="text-left p-2">IBAN</th>
            <th className="text-left p-2">Format</th>
            <th className="text-left p-2">GL code</th>
            <th className="text-left p-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(b => (
            <tr key={b.id}>
              <td className="p-2">{b.name}</td>
              <td className="p-2">{b.sort_code ?? '—'}</td>
              <td className="p-2">{b.account_number ?? '—'}</td>
              <td className="p-2">{b.iban ?? '—'}</td>
              <td className="p-2">{b.format_name}</td>
              <td className="p-2 font-mono">{b.gl_account_code}</td>
              <td className="p-2">
                <a href={`/admin/accounting/banks/${b.id}/import`} className="text-blue-600 underline">
                  Import CSV
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
