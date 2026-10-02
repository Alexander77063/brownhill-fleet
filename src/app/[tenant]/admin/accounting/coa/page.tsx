// src/app/[tenant]/admin/accounting/coa/page.tsx
import { localDb } from '@/lib/auth/local-store';

async function loadAccounts() {
  const sql = await localDb();
  return (await sql`
    select id, code, name, type, normal_balance, archived_at
      from accounting.chart_of_accounts
     where archived_at is null
     order by type, code
  `) as Array<{ id: string; code: string; name: string; type: string; normal_balance: string; archived_at: string | null }>;
}

export default async function COAPage() {
  const accounts = await loadAccounts();
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Chart of Accounts</h1>
      <form action="/api/v1/accounting/coa" method="post" className="mb-4 grid grid-cols-4 gap-2">
        <input name="code" placeholder="code (e.g. 1300)" className="border p-2" required />
        <input name="name" placeholder="account name" className="border p-2" required />
        <select name="type" className="border p-2" required>
          <option value="asset">asset</option>
          <option value="liability">liability</option>
          <option value="equity">equity</option>
          <option value="revenue">revenue</option>
          <option value="expense">expense</option>
        </select>
        <select name="normal_balance" className="border p-2" required>
          <option value="debit">debit</option>
          <option value="credit">credit</option>
        </select>
        <input type="hidden" name="_action" value="add" />
        <button className="col-span-4 px-4 py-2 bg-blue-600 text-white rounded">Add account</button>
      </form>
      <table className="min-w-full border">
        <thead>
          <tr>
            <th className="text-left p-2">Code</th>
            <th className="text-left p-2">Name</th>
            <th className="text-left p-2">Type</th>
            <th className="text-left p-2">Normal balance</th>
            <th className="text-left p-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(a => (
            <tr key={a.id}>
              <td className="p-2 font-mono">{a.code}</td>
              <td className="p-2">{a.name}</td>
              <td className="p-2">{a.type}</td>
              <td className="p-2">{a.normal_balance}</td>
              <td className="p-2">
                <form action="/api/v1/accounting/coa" method="post" className="inline">
                  <input type="hidden" name="accountId" value={a.id} />
                  <input type="hidden" name="_action" value="archive" />
                  <button className="text-red-600 underline">Archive</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
