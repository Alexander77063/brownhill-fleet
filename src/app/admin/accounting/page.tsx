// src/app/admin/accounting/page.tsx
// The owner-side hub for the in-app accounting module.
//
// This page did not exist, but eleven sibling pages under /admin/accounting/*
// back-link to it ("← Accounting") — so every one of them was a dead end, and
// the whole owner-side accounting surface was unreachable by clicking. It is
// the /admin counterpart of /accounts/accounting, which is the accountant's
// hub for the same data.
//
// Permission gate: tenant.settings — the same gate /admin/accounting/coa and
// /admin/accounting/periods already apply. The accountant-facing tree
// (/accounts/accounting/*) gates each tile on the narrower permission that
// matches what it mutates (billing.write, reports.operational); this tree is
// the owner-side full surface.

import Link from 'next/link';
import { PageHeader, Card, CardTitle, Button } from '@/components/ui';
import { requirePermission } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

export default async function AdminAccountingHomePage() {
  await requirePermission('tenant.settings');

  const tiles: { href: string; label: string; hint: string; icon: 'wallet' | 'check' | 'trending' | 'doc' | 'clock' | 'receipt' | 'shield' | 'pound' }[] = [
    { href: '/admin/accounting/banks', label: 'Bank accounts', hint: 'Add the accounts money lands in.', icon: 'wallet' },
    { href: '/admin/accounting/reconcile', label: 'Reconcile', hint: 'Match statements to the ledger.', icon: 'check' },
    { href: '/admin/accounting/coa', label: 'Chart of accounts', hint: 'The FRS 102 baseline, read-only.', icon: 'doc' },
    { href: '/admin/accounting/periods', label: 'Periods', hint: 'Close a month, reopen inside the grace window.', icon: 'clock' },
    { href: '/admin/accounting/reports/pnl', label: 'Profit & Loss', hint: 'Income and expenditure over a date range.', icon: 'trending' },
    { href: '/admin/accounting/reports/balance-sheet', label: 'Balance sheet', hint: 'What the business owns and owes.', icon: 'doc' },
    { href: '/admin/accounting/reports/cashflow', label: 'Cashflow', hint: 'Money in and money out.', icon: 'trending' },
    { href: '/admin/accounting/reports/ar-aging', label: 'AR aging', hint: 'Who owes what, and for how long.', icon: 'clock' },
    { href: '/admin/accounting/reports/vat-return', label: 'VAT return', hint: 'Box figures for the HMRC return.', icon: 'receipt' },
    { href: '/admin/accounting/mtd', label: 'HMRC MTD', hint: 'Connect to Making Tax Digital.', icon: 'shield' },
  ];

  return (
    <main className="p-6">
      <PageHeader
        eyebrow="Admin · Accounting"
        title="Accounting"
        subtitle="Chart of accounts, journals, bank reconciliation, reports and HMRC Making Tax Digital. The accountant-facing view of the same data is at /accounts/accounting."
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.href}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>{t.label}</CardTitle>
                <p className="mt-1 text-xs text-muted">{t.hint}</p>
              </div>
              <Link href={t.href}>
                <Button variant="outline" size="sm">Open</Button>
              </Link>
            </div>
          </Card>
        ))}
      </section>
    </main>
  );
}
