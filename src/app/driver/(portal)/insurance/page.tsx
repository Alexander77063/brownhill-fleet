import { PageHeader, Card, Badge, Table, Th, Td, EmptyState } from '@/components/ui';
import { Icon } from '@/components/icons';
import { getSessionProfile } from '@/lib/auth';
import { getCertificates } from '@/lib/queries';
import { formatDate, daysUntil } from '@/lib/display';
import { operatorLegalName, operatorName } from '@/lib/branding';
import { CertUploadForm } from './CertUploadForm';

export const dynamic = 'force-dynamic';

function certTone(status: string): 'profit' | 'warn' | 'loss' | 'neutral' {
  return ({ verified: 'profit', pending: 'warn', rejected: 'loss', expired: 'neutral' } as const)[status] ?? 'neutral';
}

export default async function DriverInsurance() {
  const p = await getSessionProfile();
  if (!p?.driverId) {
    return (
      <>
        <PageHeader eyebrow="Compliance" title="Insurance" />
        <EmptyState title="No active agreement linked to your account" />
      </>
    );
  }

  // RLS scopes certificates to the signed-in driver automatically.
  const certs = await getCertificates();

  // The interested party on a policy is the operator who owns the vehicle — a
  // legal entity the insurer will be asked to name. Getting this wrong is not a
  // cosmetic branding slip: the driver would put the wrong company on their
  // cover, and the vehicle's owner would have no interest recorded at all.
  const operator = await operatorName();
  const operatorLegal = await operatorLegalName();

  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        title="Insurance"
        subtitle={`Keep a valid policy on file at all times. ${operator} must be named as an interested party on your cover.`}
      />

      {/* Interested-party requirement */}
      <Card className="reveal mb-4 border-[var(--color-gold)]/40">
        <div className="flex items-start gap-3">
          <span className="text-gold-bright"><Icon name="shield" /></span>
          <div>
            <p className="text-sm text-cream">Company as interested party</p>
            <p className="mt-1 text-sm text-muted">
              Your policy must list <span className="text-parchment">{operatorLegal}</span> as an interested party
              and cover private hire / chauffeur use. Certificates are verified by ops before they take effect.
            </p>
          </div>
        </div>
      </Card>

      {/* Certificates list */}
      <section className="mb-4">
        <h2 className="mb-3 font-display text-xl text-cream">Your certificates</h2>
        {certs.length === 0 ? (
          <EmptyState title="No certificates yet" hint="Upload your current insurance certificate below." />
        ) : (
          <Table caption="Your insurance certificates">
            <thead>
              <tr>
                <Th>Insurer</Th><Th>Policy</Th><Th>Cover</Th><Th>Expiry</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => {
                const d = daysUntil(c.cover_to);
                const expiringSoon = d !== null && d >= 0 && d <= 30;
                const expired = d !== null && d < 0;
                return (
                  <tr key={c.id}>
                    <Td className="text-cream">{c.insurer}</Td>
                    <Td>{c.policy_no}</Td>
                    <Td>{formatDate(c.cover_from)} – {formatDate(c.cover_to)}</Td>
                    <Td>
                      {expired ? (
                        <Badge tone="loss"><Icon name="alert" className="h-3.5 w-3.5" /> Expired</Badge>
                      ) : expiringSoon ? (
                        <Badge tone="warn"><Icon name="clock" className="h-3.5 w-3.5" /> {d}d left</Badge>
                      ) : (
                        <span className="tnum text-muted">{d}d</span>
                      )}
                    </Td>
                    <Td><Badge tone={certTone(c.status)}>{c.status}</Badge></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>

      {/* Upload */}
      <Card>
        <CertUploadForm />
      </Card>
    </>
  );
}
