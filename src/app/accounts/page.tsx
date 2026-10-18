import { PageHeader, Stat, Card, CardTitle, Button, EmptyState, Money } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getArrears, getObligations } from '@/lib/queries';
import { requireTenantContext, contextCan } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

/**
 * The accountant dashboard — a money-focused view of the same tenant data
 * /ops/* uses. Permission-gated so each tile hides when the holder hasn't been
 * granted the read it needs (ops admin can grant exactly what they need via
 * /admin/members/[userId]).
 */
export default async function AccountsDashboard() {
  const ctx = await requireTenantContext();

  // Pull only what each tile needs; missing-permission surfaces an empty list
  // rather than throwing so the page still loads and tells the operator what
  // they're missing.
  const canBilling = contextCan(ctx, 'billing.read');
  const canCompliance = contextCan(ctx, 'compliance.read');
  const canReports = contextCan(ctx, 'reports.operational');

  const [arrears, obligations] = await Promise.all([
    canBilling ? getArrears() : Promise.resolve([]),
    canCompliance ? getObligations() : Promise.resolve([]),
  ]);

  const totalArrears = arrears.reduce((s, a) => s + (a.outstanding_pence ?? 0), 0);
  const overdueCount = arrears.filter((a) => (a.outstanding_pence ?? 0) > 0).length;
  const overdueObligations = obligations.filter(
    (o) => o.status === 'overdue' || o.severity === 'critical',
  );

  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Finance dashboard"
        subtitle="Money in, money out, what's overdue, what needs action. Tiles below only show what you're permitted to read."
      />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {canBilling && (
          <Stat
            label="Outstanding (arrears)"
            value={<Money pence={totalArrears} />}
            tone={totalArrears > 0 ? 'loss' : 'profit'}
            className="reveal"
          />
        )}
        {canBilling && (
          <Stat
            label="Drivers with arrears"
            value={overdueCount}
            tone={overdueCount > 0 ? 'warn' : 'profit'}
            className="reveal"
          />
        )}
        {canCompliance && (
          <Stat
            label="Overdue obligations"
            value={overdueObligations.length}
            tone={overdueObligations.length > 0 ? 'loss' : 'profit'}
            className="reveal"
          />
        )}
        {canReports && (
          <Stat label="Reports" value="—" hint="Operational & board" className="reveal" />
        )}
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>Quick links</CardTitle>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {canBilling && (
              <li>
                <Button href="/accounts/billing" variant="outline" size="sm" className="w-full justify-start">
                  <Icon name="receipt" className="h-4 w-4" /> Billing &amp; payments
                </Button>
              </li>
            )}
            {canBilling && (
              <li>
                <Button href="/accounts/expenses" variant="outline" size="sm" className="w-full justify-start">
                  <Icon name="wallet" className="h-4 w-4" /> Expenses
                </Button>
              </li>
            )}
            {canBilling && (
              <li>
                <Button href="/accounts/fuel" variant="outline" size="sm" className="w-full justify-start">
                  <Icon name="wallet" className="h-4 w-4" /> Fuel
                </Button>
              </li>
            )}
            {canBilling && (
              <li>
                <Button href="/accounts/finance" variant="outline" size="sm" className="w-full justify-start">
                  <Icon name="pound" className="h-4 w-4" /> Finance &amp; VAT
                </Button>
              </li>
            )}
            {canReports && (
              <li>
                <Button href="/accounts/reports" variant="outline" size="sm" className="w-full justify-start">
                  <Icon name="trending" className="h-4 w-4" /> Reports
                </Button>
              </li>
            )}
          </ul>
          {!canBilling && !canCompliance && !canReports && (
            <EmptyState
              title="Nothing to show yet"
              hint="The ops admin hasn't granted you any read permissions. Ask them to grant billing.read and reports.operational at minimum."
            />
          )}
        </Card>

        <Card>
          <CardTitle>Top arrears</CardTitle>
          {arrears.length === 0 ? (
            <EmptyState title="No arrears" hint={canBilling ? "All drivers are paid up." : "Permission not granted."} />
          ) : (
            <ul className="mt-3 space-y-2">
              {arrears
                .slice()
                .sort((a, b) => (b.outstanding_pence ?? 0) - (a.outstanding_pence ?? 0))
                .slice(0, 5)
                .map((a) => (
                  <li key={a.agreement_id} className="flex items-center justify-between gap-2 border-t border-hair-soft py-2 first:border-t-0 first:pt-0">
                    <span className="font-mono text-sm text-cream">{a.agreement_id.slice(0, 8)}…</span>
                    <span className="font-mono text-sm text-[var(--color-loss)]">
                      <Money pence={a.outstanding_pence ?? 0} />
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}