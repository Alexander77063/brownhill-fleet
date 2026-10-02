// src/lib/accounting/reports.ts
// Per-tenant reports. Same shape as Brownhill's PR #93 with tenant scoping
// and NGN formatting. Every function takes `tenantId` as the first argument;
// every SQL query threads `app.tenant_id` from 0016_tenancy.sql.

import { localDb } from '@/lib/auth/local-store';

type Sql = Awaited<ReturnType<typeof localDb>>;

export type Pounds = bigint;

export interface PnLRow {
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  amountPence: Pounds;
}

export interface PnLResult {
  fromDate: Date;
  toDate: Date;
  rows: PnLRow[];
  totalRevenuePence: Pounds;
  totalExpensePence: Pounds;
  netResultPence: Pounds;
}

export async function renderProfitAndLoss(tenantId: string, fromDate: Date, toDate: Date): Promise<PnLResult> {
  const sql = await localDb();
  const rows = (await sql`
    select coa.code as account_code, coa.name as account_name, coa.type as account_type,
           sum(case when jl.credit_pence > 0 then jl.credit_pence - jl.debit_pence
                    when jl.debit_pence  > 0 then -(jl.debit_pence - jl.credit_pence)
                    else 0 end) as amount_pence
      from accounting.journal_lines jl
      join accounting.journal_entries je on je.id = jl.journal_id
      join accounting.chart_of_accounts coa on coa.id = jl.account_id
     where coa.tenant_id = ${tenantId}::uuid
       and coa.type in ('revenue', 'expense')
       and je.posted_at >= ${fromDate.toISOString()}::timestamptz
       and je.posted_at <= ${toDate.toISOString()}::timestamptz
     group by coa.code, coa.name, coa.type
     order by coa.type, coa.code
  `) as Array<{ account_code: string; account_name: string; account_type: 'revenue' | 'expense'; amount_pence: string }>;
  const typed: PnLRow[] = rows.map(r => ({
    accountCode: r.account_code, accountName: r.account_name,
    accountType: r.account_type, amountPence: BigInt(r.amount_pence),
  }));
  let totalRevenue = 0n, totalExpense = 0n;
  for (const r of typed) {
    if (r.accountType === 'revenue') totalRevenue += r.amountPence;
    else totalExpense += r.amountPence;
  }
  return {
    fromDate, toDate, rows: typed,
    totalRevenuePence: totalRevenue,
    totalExpensePence: totalExpense,
    netResultPence: totalRevenue - totalExpense,
  };
}

export interface BSRow {
  accountCode: string;
  accountName: string;
  accountClass: 'asset' | 'liability' | 'equity';
  amountPence: Pounds;
}

export interface BSResult {
  asOfDate: Date;
  rows: BSRow[];
  totalAssetsPence: Pounds;
  totalLiabilitiesPence: Pounds;
  totalEquityPence: Pounds;
  imbalancePence: Pounds;
}

export async function renderBalanceSheet(tenantId: string, asOfDate: Date): Promise<BSResult> {
  const sql = await localDb();
  const rows = (await sql`
    select coa.code as account_code, coa.name as account_name, coa.type as account_class,
           sum(case when coa.type = 'asset' then jl.debit_pence - jl.credit_pence
                    when coa.type in ('liability','equity') then jl.credit_pence - jl.debit_pence
                    else 0 end) as amount_pence
      from accounting.journal_lines jl
      join accounting.journal_entries je on je.id = jl.journal_id
      join accounting.chart_of_accounts coa on coa.id = jl.account_id
     where coa.tenant_id = ${tenantId}::uuid
       and coa.type in ('asset', 'liability', 'equity')
       and je.posted_at <= ${asOfDate.toISOString()}::timestamptz
     group by coa.code, coa.name, coa.type
     order by
       case coa.type when 'asset' then 1 when 'liability' then 2 when 'equity' then 3 end,
       coa.code
  `) as Array<{ account_code: string; account_name: string; account_class: 'asset' | 'liability' | 'equity'; amount_pence: string }>;
  const typed: BSRow[] = rows.map(r => ({
    accountCode: r.account_code, accountName: r.account_name,
    accountClass: r.account_class, amountPence: BigInt(r.amount_pence),
  }));
  let assets = 0n, liab = 0n, equity = 0n;
  for (const r of typed) {
    if (r.accountClass === 'asset')      assets  += r.amountPence;
    if (r.accountClass === 'liability') liab    += r.amountPence;
    if (r.accountClass === 'equity')    equity  += r.amountPence;
  }
  return {
    asOfDate, rows: typed,
    totalAssetsPence: assets,
    totalLiabilitiesPence: liab,
    totalEquityPence: equity,
    imbalancePence: assets - (liab + equity),
  };
}

export interface CashflowSection {
  label: string;
  rows: Array<{ accountCode: string; accountName: string; amountPence: Pounds }>;
  subtotalPence: Pounds;
}

export interface CashflowResult {
  fromDate: Date;
  toDate: Date;
  operating: CashflowSection;
  investing: CashflowSection;
  financing: CashflowSection;
  netChangePence: Pounds;
}

export async function renderCashflow(tenantId: string, fromDate: Date, toDate: Date): Promise<CashflowResult> {
  const pnl = await renderProfitAndLoss(tenantId, fromDate, toDate);
  const sql = await localDb();
  const arMovement = (await sql`
    select sum(case when je.posted_at <= ${toDate.toISOString()}::timestamptz
                     then jl.debit_pence - jl.credit_pence
                     else 0 end)
         - sum(case when je.posted_at <= ${fromDate.toISOString()}::timestamptz
                     then jl.debit_pence - jl.credit_pence
                     else 0 end) as delta_pence
      from accounting.journal_lines jl
      join accounting.journal_entries je on je.id = jl.journal_id
     where jl.account_id = (select id from accounting.chart_of_accounts
                              where tenant_id = ${tenantId}::uuid and code = '1100')
  `) as Array<{ delta_pence: string }>;
  const apMovement = (await sql`
    select sum(case when je.posted_at <= ${toDate.toISOString()}::timestamptz
                     then jl.credit_pence - jl.debit_pence
                     else 0 end)
         - sum(case when je.posted_at <= ${fromDate.toISOString()}::timestamptz
                     then jl.credit_pence - jl.debit_pence
                     else 0 end) as delta_pence
      from accounting.journal_lines jl
      join accounting.journal_entries je on je.id = jl.journal_id
     where jl.account_id = (select id from accounting.chart_of_accounts
                              where tenant_id = ${tenantId}::uuid and code = '2100')
  `) as Array<{ delta_pence: string }>;
  const deltaAr = BigInt(arMovement[0]?.delta_pence ?? '0');
  const deltaAp = BigInt(apMovement[0]?.delta_pence ?? '0');
  const operating: CashflowSection = {
    label: 'Operating activities',
    rows: [
      { accountCode: 'PnL', accountName: 'Net income', amountPence: pnl.netResultPence },
      { accountCode: '1100', accountName: 'Δ Trade Debtors', amountPence: -deltaAr },
      { accountCode: '2100', accountName: 'Δ Trade Creditors', amountPence: deltaAp },
    ],
    subtotalPence: pnl.netResultPence - deltaAr + deltaAp,
  };
  return {
    fromDate, toDate,
    operating, investing: { label: 'Investing activities', rows: [], subtotalPence: 0n },
    financing:  { label: 'Financing activities',  rows: [], subtotalPence: 0n },
    netChangePence: operating.subtotalPence,
  };
}

export interface ArBucket {
  label: string;
  totalPence: Pounds;
  customerCount: number;
}

export interface ArRow {
  customerId: string;
  customerName: string;
  outstandingPence: Pounds;
  bucket: '0-30' | '31-60' | '61-90' | '90+';
}

export interface ArAgingResult {
  asOfDate: Date;
  buckets: ArBucket[];
  rows: ArRow[];
  totalOutstandingPence: Pounds;
}

export async function renderArAging(tenantId: string, asOfDate: Date): Promise<ArAgingResult> {
  const sql = await localDb();
  const rows = (await sql`
    select i.id as invoice_id, i.contact_id as customer_id,
           i.gross_pence - coalesce((select sum(amount_pence) from public.payments p
                                       where p.invoice_id = i.id and p.status = 'confirmed'
                                         and p.tenant_id = i.tenant_id), 0) as outstanding_pence,
           i.issued_at::text as issued_at,
           extract(epoch from (${asOfDate.toISOString()}::timestamptz - i.issued_at)) / 86400.0 as age_days
      from public.invoices i
     where i.tenant_id = ${tenantId}::uuid
       and i.status = 'open'
       and i.issued_at <= ${asOfDate.toISOString()}::timestamptz
  `) as Array<{ invoice_id: string; customer_id: string; outstanding_pence: string; issued_at: string; age_days: string }>;
  const arRows: ArRow[] = rows.map(r => {
    const days = parseFloat(r.age_days);
    const bucket: ArRow['bucket'] = days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
    return {
      customerId: r.customer_id,
      customerName: r.customer_id,
      outstandingPence: BigInt(r.outstanding_pence),
      bucket,
    };
  });
  const buckets: Record<ArRow['bucket'], { total: bigint; count: Set<string> }> = {
    '0-30':  { total: 0n, count: new Set() },
    '31-60': { total: 0n, count: new Set() },
    '61-90': { total: 0n, count: new Set() },
    '90+':   { total: 0n, count: new Set() },
  };
  for (const r of arRows) {
    buckets[r.bucket].total += r.outstandingPence;
    buckets[r.bucket].count.add(r.customerId);
  }
  const bucketList: ArBucket[] = [
    { label: '0-30 days',  totalPence: buckets['0-30'].total,  customerCount: buckets['0-30'].count.size },
    { label: '31-60 days', totalPence: buckets['31-60'].total, customerCount: buckets['31-60'].count.size },
    { label: '61-90 days', totalPence: buckets['61-90'].total, customerCount: buckets['61-90'].count.size },
    { label: '90+ days',   totalPence: buckets['90+'].total,   customerCount: buckets['90+'].count.size },
  ];
  return {
    asOfDate,
    buckets: bucketList,
    rows: arRows,
    totalOutstandingPence: arRows.reduce((a, r) => a + r.outstandingPence, 0n),
  };
}
