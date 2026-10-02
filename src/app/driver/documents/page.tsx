import { PageHeader, Card, CardTitle, Badge, Button, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getSessionProfile } from '@/lib/auth';
import { getMyActiveAgreement, getCertificates } from '@/lib/queries';
import { formatDate } from '@/lib/display';
import { getAuthContext } from '@/lib/auth/context';
import { listDriverDocuments } from '@/lib/driver-documents';
// Aliased: this page's own default export is already called DriverDocuments.
import { DriverDocuments as DriverDocumentsPanel } from '@/components/DriverDocuments';
import { uploadMyDocumentAction } from '@/lib/actions/driver-documents';

export const dynamic = 'force-dynamic';

export default async function DriverDocuments() {
  const p = await getSessionProfile();
  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Paperwork" title="Documents" />
        <EmptyState title="No active agreement linked to your account" />
      </>
    );
  }

  const ag = await getMyActiveAgreement(p.driverId);
  const certs = await getCertificates();
  const ctx = await getAuthContext();
  const documents = ctx?.tenantId ? await listDriverDocuments(ctx.tenantId, p.driverId) : [];
  // signed_doc_path exists on the row (select '*') but not on the hand-written
  // Agreement type — narrow it locally without editing the shared type module.
  const signedDocPath = (ag as { signed_doc_path?: string | null } | null)?.signed_doc_path ?? null;

  return (
    <>
      <PageHeader
        eyebrow="Paperwork"
        title="Documents"
        subtitle="Your signed agreement, contract and supporting paperwork in one place."
      />

      {/* Agreement / contract */}
      <Card className="reveal mb-4">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Hire agreement</CardTitle>
          {ag && (
            <Badge tone={ag.type === 'rtb' ? 'gold' : 'neutral'}>
              {ag.type === 'rtb' ? 'Rent-to-Buy' : 'Standard'}
            </Badge>
          )}
        </div>

        {!ag ? (
          <EmptyState title="No agreement on file" />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-hair-soft px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="text-gold"><Icon name="signature" /></span>
                <div>
                  <p className="text-sm text-cream">Your contract</p>
                  <p className="text-xs text-muted">
                    {ag.signed_on ? `Signed ${formatDate(ag.signed_on)}` : 'Awaiting signature'}
                    {ag.vehicle ? ` · ${ag.vehicle.registration}` : ''}
                  </p>
                </div>
              </div>
              {/* Plain anchor (not next/link) so the contract API route is never prefetched. */}
              <a
                href={`/api/contracts/${ag.id}`}
                className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border border-hair px-3 py-1.5 text-xs font-semibold text-gold-bright transition-all duration-200 hover:bg-[rgba(184,151,42,0.08)]"
              >
                <Icon name="file" className="h-4 w-4" /> View contract
              </a>
            </div>

            {signedDocPath && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-hair-soft px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-gold"><Icon name="doc" /></span>
                  <div>
                    <p className="text-sm text-cream">Signed copy</p>
                    <p className="text-xs text-muted">Your countersigned agreement</p>
                  </div>
                </div>
                <a
                  href={`/api/contracts/${ag.id}?signed=1`}
                  className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] px-3 py-1.5 text-xs font-semibold text-parchment transition-all duration-200 hover:bg-[var(--surface)] hover:text-cream"
                >
                  Download <Icon name="chevron" className="h-4 w-4" />
                </a>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Licences and other paperwork — one upload flow for everything except
          insurance, which keeps its dedicated page because of the cover dates. */}
      <div className="mb-4">
        <DriverDocumentsPanel
          documents={documents}
          uploadAction={uploadMyDocumentAction}
          audience="driver"
          heading="Your licences & paperwork"
          /* Names no specific document: which ones apply is the region's
             business, and the list above already says. Naming a PCO licence
             here would be meaningless to a driver in Lagos. */
          intro="Add your licences and any other document we've asked for. Adding an expiry date means we'll remind you before it runs out. Your fleet operator checks each document before it counts towards your compliance record."
        />
      </div>

      {/* Insurance documents */}
      <Card className="reveal">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Insurance documents</CardTitle>
          <Button href="/driver/insurance" variant="ghost" size="sm">Manage <Icon name="chevron" className="h-4 w-4" /></Button>
        </div>
        {certs.length === 0 ? (
          <EmptyState title="No insurance documents" hint="Upload your certificate from the Insurance page." />
        ) : (
          <ul className="space-y-2">
            {certs.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-hair-soft px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-gold"><Icon name="shield" /></span>
                  <div>
                    <p className="text-sm text-cream">{c.insurer} · {c.policy_no}</p>
                    <p className="text-xs text-muted">Cover to {formatDate(c.cover_to)}</p>
                  </div>
                </div>
                <Badge tone={c.status === 'verified' ? 'profit' : c.status === 'pending' ? 'warn' : c.status === 'rejected' ? 'loss' : 'neutral'}>
                  {c.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
