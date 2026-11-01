import Link from 'next/link';
import { PageHeader, Card, CardTitle, Button } from '@/components/ui';
import { Icon } from '@/components/icons';
import { requireTenantContext, contextCan } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

/**
 * /accounts/accounting — the accountant's hub for the in-app accounting module.
 * Each tile gates on its own permission so an accountant granted only
 * `billing.read` (and not the full write set) still sees the read-only tiles
 * (P&L, BS, cashflow, AR aging, VAT return).
 *
 * The full surface is also at /admin/accounting/* for ops users — the two
 * trees share the same data layer and the same chart of accounts.
 */
export default async function AccountingHomePage() {
  const ctx = await requireTenantContext();
  // The hub itself is reachable by anyone with `billing.read`. Individual
  // sub-pages gate on the permission that matches what they mutate.
  if (!contextCan(ctx, 'billing.read') && !contextCan(ctx, 'reports.operational')) {
    return (
      <>
        <PageHeader eyebrow="Accounts" title="Accounting" />
        <Card>
          <p className="text-sm text-muted">
            You don&apos;t have permission to read the accounting module. Ask the ops admin to grant
            you <code>billing.read</code> or <code>reports.operational</code>.
          </p>
        </Card>
      </>
    );
  }

  const tiles: { href: string; label: string; perm: string; icon: 'wallet' | 'check' | 'trending' | 'doc' | 'clock' | 'receipt' | 'shield' | 'pound' }[] = [
    { href: '/accounts/accounting/banks', label: 'Bank accounts', perm: 'billing.write', icon: 'wallet' },
    { href: '/accounts/accounting/reconcile', label: 'Reconcile', perm: 'billing.write', icon: 'check' },
    // Chart of accounts and periods were reachable only by typing the URL —
    // they existed, they were never linked from the hub or the nav.
    { href: '/accounts/accounting/coa', label: 'Chart of accounts', perm: 'billing.read', icon: 'doc' },
    { href: '/accounts/accounting/periods', label: 'Periods', perm: 'billing.write', icon: 'clock' },
    { href: '/accounts/accounting/reports/pnl', label: 'Profit & Loss', perm: 'reports.operational', icon: 'trending' },
    { href: '/accounts/accounting/reports/balance-sheet', label: 'Balance sheet', perm: 'reports.operational', icon: 'doc' },
    { href: '/accounts/accounting/reports/cashflow', label: 'Cashflow', perm: 'reports.operational', icon: 'trending' },
    { href: '/accounts/accounting/reports/ar-aging', label: 'AR aging', perm: 'reports.operational', icon: 'clock' },
    { href: '/accounts/accounting/reports/vat-return', label: 'VAT return', perm: 'reports.operational', icon: 'receipt' },
    { href: '/accounts/accounting/mtd', label: 'HMRC MTD', perm: 'tenant.settings', icon: 'shield' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Accounts · Accounting"
        title="In-app accounting"
        subtitle="Chart of accounts, journal entries, bank reconciliation, reports, and HMRC Making Tax Digital. The accountant-facing surface; the same data is reachable to ops at /admin/accounting/*."
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => {
          const can = contextCan(ctx, t.perm as Parameters<typeof contextCan>[1]);
          return (
            <Card key={t.href}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle>{t.label}</CardTitle>
                  <p className="mt-1 text-xs text-muted">
                    requires <code className="font-mono">{t.perm}</code>
                  </p>
                </div>
                {can ? (
                  <Link href={t.href}>
                    <Button variant="outline" size="sm">Open</Button>
                  </Link>
                ) : (
                  <Button variant="ghost" size="sm" disabled title={`Missing ${t.perm}`}>
                    Locked
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </section>

      <section className="mt-4">
        <Card>
          <CardTitle>About this module</CardTitle>
          <p className="mt-3 text-sm text-muted">
            Brought in from <code>elite-fleet-management</code> via PRs #85–#95
            (foundation, auto-posting, period-lock, bank-rec, reports,
            MTD-VAT, acceptance). The schema migrations{' '}
            <code>0064_accounting_schema.sql</code> through{' '}
            <code>0068_accounting_rls.sql</code> are applied at bootstrap time;
            the FRS 102 chart of accounts is seeded by{' '}
            <code>0065_accounting_coa_seed.sql</code>; UK VAT codes T0 / T1 /
            T5 / T9 by <code>0066_accounting_vat_codes_seed.sql</code>.
          </p>
          <p className="mt-3 text-sm text-muted">
            <Icon name="alert" className="mr-1 inline h-4 w-4" />
            The accounting module is opt-in: pages render correctly only when
            the schema is applied and the chart of accounts has rows. Until
            then the sub-pages will throw or render empty — that&apos;s the
            expected signal that bootstrap hasn&apos;t run yet.
          </p>
        </Card>
      </section>
    </>
  );
}