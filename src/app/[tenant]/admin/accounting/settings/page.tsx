// src/app/[tenant]/admin/accounting/settings/page.tsx
import { localDb } from '@/lib/auth/local-store';

async function loadSettings() {
  const sql = await localDb();
  return (await sql`
    select filing_mode, filing_cadence, tin, enabled,
           reopen_window_days, bank_statement_max_bytes, bank_statement_max_txns,
           auto_match_threshold_pct, vat_t1_rate_pct
      from accounting.tenant_accounting_settings
    limit 1
  `) as Array<{
    filing_mode: string; filing_cadence: string; tin: string; enabled: boolean;
    reopen_window_days: number; bank_statement_max_bytes: number; bank_statement_max_txns: number;
    auto_match_threshold_pct: number; vat_t1_rate_pct: string;
  }>;
}

export default async function SettingsPage() {
  const s = (await loadSettings())[0] ?? {
    filing_mode: 'manual_upload',
    filing_cadence: 'monthly',
    tin: '',
    enabled: false,
    reopen_window_days: 7,
    bank_statement_max_bytes: 10485760,
    bank_statement_max_txns: 5000,
    auto_match_threshold_pct: 90,
    vat_t1_rate_pct: '7.50',
  };
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Accounting settings</h1>
      <form action="/api/v1/accounting/settings" method="post" className="space-y-3 max-w-md">
        <label className="block">
          <input type="checkbox" name="enabled" defaultChecked={s.enabled} />
          {' '}Enable accounting for this tenant
        </label>
        <label className="block">
          TIN
          <input name="tin" defaultValue={s.tin} className="border p-2 w-full" placeholder="12345678-0001" required />
        </label>
        <label className="block">
          Filing mode
          <select name="filing_mode" defaultValue={s.filing_mode} className="border p-2 w-full">
            <option value="manual_upload">manual_upload (PDF + signed XML + CSV)</option>
            <option value="firs_itas_direct">firs_itas_direct (POST to FIRS-ITAS)</option>
          </select>
        </label>
        <label className="block">
          Filing cadence
          <select name="filing_cadence" defaultValue={s.filing_cadence} className="border p-2 w-full">
            <option value="monthly">monthly</option>
            <option value="quarterly">quarterly</option>
          </select>
        </label>
        <fieldset className="border rounded p-3">
          <legend className="text-sm font-semibold">Thresholds (per-tenant overrides)</legend>
          <label className="block mt-2">
            Reopen window (days, 1-90)
            <input type="number" name="reopen_window_days" min={1} max={90} defaultValue={s.reopen_window_days} className="border p-2 w-full" />
          </label>
          <label className="block">
            Bank statement max bytes (default 10 MB)
            <input type="number" name="bank_statement_max_bytes" min={1024} max={1073741824} defaultValue={s.bank_statement_max_bytes} className="border p-2 w-full" />
          </label>
          <label className="block">
            Bank statement max transactions (default 5000)
            <input type="number" name="bank_statement_max_txns" min={1} max={100000} defaultValue={s.bank_statement_max_txns} className="border p-2 w-full" />
          </label>
          <label className="block">
            Auto-match confidence threshold (0-100, default 90)
            <input type="number" name="auto_match_threshold_pct" min={0} max={100} defaultValue={s.auto_match_threshold_pct} className="border p-2 w-full" />
          </label>
          <label className="block">
            VAT T1 rate % (default 7.5)
            <input type="number" step="0.01" name="vat_t1_rate_pct" min={0} max={100} defaultValue={s.vat_t1_rate_pct} className="border p-2 w-full" />
          </label>
        </fieldset>
        <button className="px-4 py-2 bg-blue-600 text-white rounded">Save</button>
      </form>
    </main>
  );
}
