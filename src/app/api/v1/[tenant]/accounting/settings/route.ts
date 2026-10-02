// src/app/api/v1/[tenant]/accounting/settings/route.ts
// POST handler — updates tenant_accounting_settings and (on enable) seeds the COA.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { seedNigerianCOA } from '@/lib/accounting/nigeria/coa-custom';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const sql = await localDb();
  const enabled = form.get('enabled') === 'on';
  const tin = String(form.get('tin') ?? '');
  const filing_mode = String(form.get('filing_mode') ?? 'manual_upload');
  const filing_cadence = String(form.get('filing_cadence') ?? 'monthly');
  const reopen_window_days = Math.max(1, Math.min(90, Number(form.get('reopen_window_days') ?? 7) | 0));
  const bank_statement_max_bytes = Math.max(1024, Math.min(1073741824, Number(form.get('bank_statement_max_bytes') ?? 10485760) | 0));
  const bank_statement_max_txns = Math.max(1, Math.min(100000, Number(form.get('bank_statement_max_txns') ?? 5000) | 0));
  const auto_match_threshold_pct = Math.max(0, Math.min(100, Number(form.get('auto_match_threshold_pct') ?? 90) | 0));
  const vatT1Raw = String(form.get('vat_t1_rate_pct') ?? '7.5');
  const vat_t1_rate_pct = Math.max(0, Math.min(100, Number(vatT1Raw))) || 7.5;

  await sql`
    insert into accounting.tenant_accounting_settings
      (tenant_id, filing_mode, filing_cadence, tin, enabled, enabled_at,
       reopen_window_days, bank_statement_max_bytes, bank_statement_max_txns,
       auto_match_threshold_pct, vat_t1_rate_pct)
    values (current_app_user()::uuid,
            ${filing_mode}::accounting_filing_mode,
            ${filing_cadence}::accounting_filing_cadence,
            ${tin},
            ${enabled},
            case when ${enabled} then now() else null end,
            ${reopen_window_days}, ${bank_statement_max_bytes}, ${bank_statement_max_txns},
            ${auto_match_threshold_pct}, ${vat_t1_rate_pct})
    on conflict (tenant_id) do update set
      filing_mode = excluded.filing_mode,
      filing_cadence = excluded.filing_cadence,
      tin = excluded.tin,
      enabled = excluded.enabled,
      enabled_at = case when excluded.enabled then now() else null end,
      reopen_window_days = excluded.reopen_window_days,
      bank_statement_max_bytes = excluded.bank_statement_max_bytes,
      bank_statement_max_txns = excluded.bank_statement_max_txns,
      auto_match_threshold_pct = excluded.auto_match_threshold_pct,
      vat_t1_rate_pct = excluded.vat_t1_rate_pct
  `;

  if (enabled) {
    await seedNigerianCOA();
  }

  return NextResponse.redirect(new URL(new URL(req.url).pathname.replace('/api/', '/'), req.url), 303);
}
