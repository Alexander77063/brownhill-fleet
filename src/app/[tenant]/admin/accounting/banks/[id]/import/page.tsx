// src/app/[tenant]/admin/accounting/banks/[id]/import/page.tsx
import { localDb } from '@/lib/auth/local-store';

interface BankAccountRow { id: string; name: string; format_name: string; gl_account_code: string }

async function loadBankAccount(id: string): Promise<BankAccountRow | null> {
  const sql = await localDb();
  const rows = (await sql`
    select ba.id, ba.name, ba.format_name, coa.code as gl_account_code
      from accounting.bank_accounts ba
      join accounting.chart_of_accounts coa on coa.id = ba.gl_account_id
     where ba.id = ${id}::uuid
  `) as Array<BankAccountRow>;
  return rows[0] ?? null;
}

export default async function BankImportPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { id } = await params;
  const bank = await loadBankAccount(id);
  if (!bank) return <main className="p-6">Bank account not found.</main>;
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Import CSV</h1>
      <p className="text-sm text-gray-600 mb-4">
        Bank: <strong>{bank.name}</strong> · Format: <code>{bank.format_name}</code> · GL: <code>{bank.gl_account_code}</code>
      </p>
      <form action="/api/v1/accounting/banks/[id]/import" method="post" encType="multipart/form-data" className="space-y-3 max-w-lg">
        <input type="file" name="file" accept=".csv,.tsv,.ofx" required className="block" />
        <button className="px-4 py-2 bg-blue-600 text-white rounded">Upload</button>
      </form>
      <p className="text-xs text-gray-500 mt-2">
        Limits per tenant settings: file size ≤ {`{bankStatementMaxBytes}`} bytes; transactions ≤ {`{bankStatementMaxTxns}`}. Auto-match ≥ {`{autoMatchThresholdPct}`}% confidence.
      </p>
    </main>
  );
}
