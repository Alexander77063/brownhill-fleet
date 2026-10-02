import Link from 'next/link';
import { Card, CardTitle, Badge, Button } from '@/components/ui';
import { formatDate } from '@/lib/display';
import { saveVehicleComplianceAction } from '@/lib/actions/vehicle-compliance';
import type { ComplianceStatus, ComplianceViewRow } from '@/lib/compliance-view';
import { hasExpiredMandatory, hasOutstandingMandatory } from '@/lib/compliance-view';

const inputCls =
  'w-full rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

/**
 * What each status is called on screen, and how loudly.
 *
 * "Not recorded" rather than "missing": the document may well be in a folder in
 * the office. What the system knows is that nobody has entered it, and saying so
 * plainly is more useful than implying the vehicle is illegal.
 */
const STATUS: Record<ComplianceStatus, { label: string; tone: 'loss' | 'warn' | 'profit' | 'neutral' | 'info' }> = {
  expired: { label: 'Expired', tone: 'loss' },
  due_soon: { label: 'Due soon', tone: 'warn' },
  valid: { label: 'In date', tone: 'profit' },
  missing: { label: 'Not recorded', tone: 'neutral' },
  recorded: { label: 'Held', tone: 'profit' },
  elsewhere: { label: 'On the driver', tone: 'info' },
};

function statusDetail(row: ComplianceViewRow): string {
  if (row.status === 'expired') return `Expired ${formatDate(row.expiresOn)}`;
  if (row.status === 'due_soon') {
    const d = row.daysLeft ?? 0;
    return d === 0 ? 'Expires today' : `Expires ${formatDate(row.expiresOn)} — ${d} day${d === 1 ? '' : 's'}`;
  }
  if (row.status === 'valid') return `Expires ${formatDate(row.expiresOn)}`;
  if (row.status === 'recorded') return row.reference ? `Reference ${row.reference}` : 'On file';
  return '';
}

/**
 * The documents this vehicle needs, and the form to record them.
 *
 * The list comes from the active region pack, so a Nigerian install asks for a
 * certificate of roadworthiness and a vehicle licence while a UK one asks for an
 * MOT — without this component knowing which country it is running in.
 */
export function VehicleComplianceCard({
  vehicleId,
  rows,
}: {
  vehicleId: string;
  rows: ComplianceViewRow[];
}) {
  // Two different claims, kept apart on purpose. A lapsed mandatory document
  // really does stop the vehicle being assigned; one that was never entered does
  // not, and a badge saying otherwise would be wrong about the law on every
  // vehicle the day it is imported.
  const expired = hasExpiredMandatory(rows);
  const outstanding = hasOutstandingMandatory(rows);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Compliance documents</CardTitle>
        {expired ? (
          <Badge tone="loss">Not road legal</Badge>
        ) : outstanding ? (
          <Badge tone="warn">Documents outstanding</Badge>
        ) : (
          <Badge tone="profit">Documents in order</Badge>
        )}
      </div>

      <p className="mt-2 text-sm text-muted">
        What this vehicle must hold to be on the road here. Overdue mandatory documents stop it being
        assigned to a driver.
      </p>

      <ul className="mt-3 divide-y divide-hair-soft">
        {rows.map((row) => (
          <li key={row.key} className="py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-sm font-medium text-cream">{row.label}</span>
              <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
              {!row.mandatory && <span className="text-xs text-muted">optional</span>}
            </div>

            <p className="mt-0.5 text-xs text-muted">
              {row.authority}
              {statusDetail(row) && <> · {statusDetail(row)}</>}
            </p>

            {row.managedOn ? (
              // Cover is held against the driver, so this links rather than asking.
              // An expiry entered here would ground a vehicle whose hirer is insured.
              <p className="mt-2 text-xs text-parchment">
                Recorded on{' '}
                <Link href={row.managedOn.href} className="text-gold-bright underline">
                  {row.managedOn.label}
                </Link>
                .
              </p>
            ) : (
              <form action={saveVehicleComplianceAction} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="vehicle_id" value={vehicleId} />
                <input type="hidden" name="obligation_key" value={row.key} />

                {row.expires && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-parchment">Expires</span>
                    <input
                      type="date"
                      name="expires_on"
                      defaultValue={row.expiresOn ?? ''}
                      aria-label={`${row.label} expiry date`}
                      className={inputCls}
                    />
                  </label>
                )}

                {/* Column-backed documents (MOT, vehicle tax) have nowhere to put a
                    reference — their storage is a single date column shared with
                    the agreement PDF, and inventing a second home for the
                    certificate number is how the two drift apart. */}
                {!row.columnBacked && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-parchment">
                      {row.expires ? 'Reference' : 'Certificate number'}
                    </span>
                    <input
                      name="reference"
                      defaultValue={row.reference ?? ''}
                      placeholder="optional"
                      aria-label={`${row.label} reference`}
                      className={inputCls}
                    />
                  </label>
                )}

                <Button type="submit" variant="outline" size="sm">
                  Save
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
