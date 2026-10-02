import { Card, CardTitle, Badge, Button, EmptyState } from '@/components/ui';
import { formatDate } from '@/lib/display';
import {
  allowsReferenceOnly,
  documentKinds,
  documentLabel,
  expiryExpected,
  type DriverDocument,
} from '@/lib/driver-documents';
import { regionProvider } from '@/lib/region';
import { buildComplianceView, hasExpiredMandatory, hasOutstandingMandatory } from '@/lib/compliance-view';

const inputCls =
  'w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

function expiryTone(expiresOn: string | null): 'neutral' | 'profit' | 'warn' | 'loss' {
  if (!expiresOn) return 'neutral';
  const days = Math.round((new Date(expiresOn).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return 'loss';
  if (days <= 30) return 'warn';
  return 'profit';
}

function expiryLabel(expiresOn: string | null): string {
  if (!expiresOn) return 'No expiry';
  const days = Math.round((new Date(expiresOn).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `Expired ${formatDate(expiresOn)}`;
  if (days === 0) return 'Expires today';
  if (days <= 30) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  return `Valid to ${formatDate(expiresOn)}`;
}

/**
 * Who is reading. The facts are identical; the wording is not — "cannot be
 * dispatched" is how an operator thinks about a driver, and not how to tell
 * someone that about themselves.
 */
export type DocumentAudience = 'ops' | 'driver';

const SUMMARY: Record<DocumentAudience, { expired: string; outstanding: string; clear: string }> = {
  ops: {
    expired: 'Cannot be dispatched',
    outstanding: 'Documents outstanding',
    clear: 'Complete',
  },
  driver: {
    expired: 'Renew to keep driving',
    outstanding: 'Something still needed',
    clear: 'All up to date',
  },
};

/**
 * What this country requires of a driver, and which of it is on file.
 *
 * Without this an operator sees only what has been uploaded, which reads as
 * complete however little is there. A Nigerian operator needs to know that an
 * FRSC licence is missing; a UK one that the DBS check is.
 */
function RequiredDocuments({
  documents,
  audience,
}: {
  documents: DriverDocument[];
  audience: DocumentAudience;
}) {
  const specs = regionProvider().driverCompliance;
  const rows = buildComplianceView(
    specs,
    documents.map((d) => ({
      obligation_key: d.kind,
      expires_on: d.expires_on,
      reference: d.reference,
    })),
    // The PCO licence's expiry is written through to `drivers.pco_licence_expiry`,
    // but the document row carries the same date, so the record is the honest
    // source here and no column values need passing.
    {},
    new Date().toISOString().slice(0, 10),
  );

  const expired = hasExpiredMandatory(rows);
  const outstanding = hasOutstandingMandatory(rows);

  return (
    <div className="mt-3 rounded-[var(--radius)] border border-hair-soft p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow text-parchment">Required in {regionProvider().label}</p>
        {expired ? (
          <Badge tone="loss">{SUMMARY[audience].expired}</Badge>
        ) : outstanding ? (
          <Badge tone="warn">{SUMMARY[audience].outstanding}</Badge>
        ) : (
          <Badge tone="profit">{SUMMARY[audience].clear}</Badge>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-cream">
              {r.label}
              {!r.mandatory && <span className="ml-2 text-xs text-muted">optional</span>}
            </span>
            <span className="text-xs text-muted">
              {r.status === 'missing'
                ? 'Not recorded'
                : r.status === 'recorded'
                  ? (r.reference ?? 'On file')
                  : expiryLabel(r.expiresOn)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One place to see and add every document about a driver.
 *
 * Used by both the ops driver page and the driver's own portal — the difference is
 * which server action is passed in and whether deletion is offered. The list of
 * document types comes from the active region pack, so a Nigerian install offers
 * NIN, FRSC licence and LASDRI card where a UK one offers PCO licence and DBS.
 */
export function DriverDocuments({
  documents,
  uploadAction,
  deleteAction,
  driverId,
  heading = 'Documents',
  intro,
  showRequired = true,
  audience = 'ops',
}: {
  documents: DriverDocument[];
  uploadAction: (formData: FormData) => Promise<void>;
  /** Omitted in the driver portal — a driver may add paperwork but not remove it. */
  deleteAction?: (formData: FormData) => Promise<void>;
  /** Present for the ops form; the driver portal derives the driver from the session. */
  driverId?: string;
  heading?: string;
  intro?: string;
  showRequired?: boolean;
  audience?: DocumentAudience;
}) {
  const kinds = documentKinds();
  const needExpiry = expiryExpected();
  const referenceOnly = kinds.filter(allowsReferenceOnly);

  return (
    <Card className="reveal">
      <CardTitle>{heading}</CardTitle>
      {intro && <p className="mt-1 text-xs text-muted">{intro}</p>}

      {showRequired && <RequiredDocuments documents={documents} audience={audience} />}

      {documents.length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No documents yet" hint="Add a licence or other paperwork below." />
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {documents.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-hair-soft px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm text-cream">
                  {d.kind === 'other' && d.title ? d.title : documentLabel(d.kind)}
                </p>
                <p className="text-xs text-muted">
                  {d.reference ? `${d.reference} · ` : ''}
                  Added {formatDate(d.created_at)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={expiryTone(d.expires_on)}>{expiryLabel(d.expires_on)}</Badge>
                {/* A reference-only record — a NIN is a number — has no file to
                    open. A "View" link that 404s reads as data loss. */}
                {d.doc_path && (
                  /* Plain anchor, not next/link: the file route must never be prefetched. */
                  <a
                    href={`/api/driver-documents/${d.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-gold-bright hover:underline"
                  >
                    View
                  </a>
                )}
                {deleteAction && (
                  <form action={deleteAction}>
                    <input type="hidden" name="document_id" value={d.id} />
                    <input type="hidden" name="driver_id" value={d.driver_id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-[var(--color-loss)]">
                      Delete
                    </Button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form action={uploadAction} className="mt-4 grid grid-cols-1 gap-3 border-t border-hair-soft pt-4 sm:grid-cols-2">
        {driverId && <input type="hidden" name="driver_id" value={driverId} />}

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">
            Document type
          </span>
          {/* Defaults to the first kind this region uses. A hardcoded default is
              an invalid option on the other region's build, which renders the
              select with nothing chosen. */}
          <select name="kind" required defaultValue={kinds[0]} className={inputCls}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {documentLabel(k)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">File</span>
          {/* Not `required`: some documents are a number rather than a scan. The
              server decides — a file means an upload, no file means a
              reference-only record, and a kind that needs a file says so. */}
          <input
            type="file"
            name="file"
            accept="image/*,application/pdf"
            capture="environment"
            className={`${inputCls} file:mr-2 file:rounded file:border-0 file:bg-navy-2 file:px-2 file:py-1 file:text-xs file:text-cream`}
          />
          {referenceOnly.length > 0 && (
            <span className="mt-1 block text-[11px] text-muted">
              Not needed for {referenceOnly.map(documentLabel).join(', ')} — the number on its own is
              enough.
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">
            Reference / number
          </span>
          <input name="reference" placeholder="Licence or certificate number" className={inputCls} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Issued on</span>
          <input type="date" name="issued_on" className={inputCls} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">
            Expires on
          </span>
          <input type="date" name="expires_on" className={inputCls} />
          <span className="mt-1 block text-[11px] text-muted">
            Needed for {needExpiry.map(documentLabel).join(', ')} — it drives the renewal reminders.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">
            Label (for “Other”)
          </span>
          <input name="title" placeholder="e.g. Enhanced DBS certificate" className={inputCls} />
        </label>

        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" size="sm">
            Add document
          </Button>
        </div>
      </form>
    </Card>
  );
}
