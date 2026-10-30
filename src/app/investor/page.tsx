import { PageHeader, Card, EmptyState } from '@/components/ui';
import { RtbReportSection } from '@/components/rtb/RtbReportSection';
import { RtbReportActions } from '@/components/rtb/RtbReportActions';
import { requireTenantContext } from '@/lib/auth/context';
import { hasEntitlement } from '@/lib/entitlements';
import { assembleRtbReportFor } from '@/lib/reports/rtb-data';

export const dynamic = 'force-dynamic';

/**
 * The investor's own portal.
 *
 * Figures, not names: the read goes through `v_investor_rtb`, the PII-free
 * view the database exposes to investors, so the rentee's identity is never
 * in this page even by accident.
 */
export default async function InvestorHomePage() {
  const ctx = await requireTenantContext();
  const entitled = await hasEntitlement('reports.investor').catch(() => false);

  if (!entitled) {
    return (
      <>
        <PageHeader eyebrow="Investor" title="Portfolio" />
        <EmptyState
          title="Investor reporting isn't part of your plan"
          hint="Ask Brownhill to enable the investor reporting module for this account."
        />
      </>
    );
  }

  const report = await assembleRtbReportFor(ctx.tenantId, 'investor').catch(() => null);

  return (
    <>
      <PageHeader
        eyebrow="Investor"
        title="Portfolio"
        subtitle="What the rent-to-buy book returns, and the rate the rentees pay on it."
      />

      {report ? (
        <RtbReportSection
          report={report}
          showNames={false}
          title="Rent-to-buy portfolio"
          subtitle="Every rent-to-buy agreement, the money in, the money out, and the return the book makes."
          actions={<RtbReportActions audience="investor" label="investor report" canSend={false} />}
        />
      ) : (
        <Card>
          <EmptyState
            title="The report is unavailable"
            hint="The portfolio could not be read. Try again in a moment, or ask Brownhill for the figures."
          />
        </Card>
      )}
    </>
  );
}
