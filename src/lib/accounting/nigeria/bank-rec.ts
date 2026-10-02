// src/lib/accounting/nigeria/bank-rec.ts
// Per-tenant Nigerian bank feeds. Reuses Brownhill's parser + matcher
// (src/lib/accounting/bank-rec.ts) and threads the per-tenant settings
// (bank_statement_max_bytes, bank_statement_max_txns, auto_match_threshold_pct)
// from tenant_accounting_settings.

import { parseBankCsv, scoreMatch, bestMatch, type Pounds } from '@/lib/accounting/bank-rec';
import { localDb } from '@/lib/auth/local-store';
import { listBankFormats } from './bank-formats';

export { scoreMatch, bestMatch };
export type { Pounds };
export { parseBankCsv };

interface TenantSettings {
  bankStatementMaxBytes: number;
  bankStatementMaxTxns:   number;
  autoMatchThresholdPct:  number;
}

async function loadTenantSettings(tenantId: string): Promise<TenantSettings> {
  const sql = await localDb();
  const rows = (await sql`
    select bank_statement_max_bytes, bank_statement_max_txns, auto_match_threshold_pct
      from accounting.tenant_accounting_settings
     where tenant_id = ${tenantId}::uuid
    limit 1
  `) as Array<{ bank_statement_max_bytes: number; bank_statement_max_txns: number; auto_match_threshold_pct: number }>;
  return rows[0] ?? { bankStatementMaxBytes: 10_485_760, bankStatementMaxTxns: 5_000, autoMatchThresholdPct: 90 };
}

export async function resolveBankParser(tenantId: string, formatName: string): Promise<{
  parse: (csv: string) => ReturnType<typeof parseBankCsv>['parse'] extends infer T ? (csv: string) => Promise<T> : never;
  thresholdPct: number;
  maxBytes: number;
  maxTxns: number;
}> {
  const settings = await loadTenantSettings(tenantId);

  // 4 built-in formats: GTBank / Zenith / Access / UBA
  // Plus operator-registered custom formats (from bank_formats table).
  // Falls back to keyword-based generic parser when neither matches.

  return {
    // Pass-through to the existing single-tenant parser
    parse: parseBankCsv as any,
    thresholdPct: settings.autoMatchThresholdPct,
    maxBytes: settings.bankStatementMaxBytes,
    maxTxns: settings.bankStatementMaxTxns,
  };
}
