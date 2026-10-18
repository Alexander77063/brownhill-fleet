// /ops/comms/page.tsx
//
// Send a one-shot notice to drivers, owners, or "everyone". Server Component
// shell that fetches the recipient rosters and hands them to a Client form
// for the actual UI.

import { PageHeader, Card, CardTitle } from '@/components/ui';
import { getAuthContext } from '@/lib/auth/context';
import { listDriversForComms, listOwnersForComms, listStaffForComms } from '@/lib/comms';
import { SendNoticeForm } from './SendNoticeForm';

export const dynamic = 'force-dynamic';

export default async function CommsPage() {
  const ctx = await getAuthContext();
  const tenantId = ctx?.tenantId ?? '';

  const [drivers, owners, staff] = tenantId
    ? await Promise.all([
        listDriversForComms(tenantId),
        listOwnersForComms(tenantId),
        listStaffForComms(tenantId),
      ])
    : [[], [], []];

  return (
    <>
      <PageHeader
        eyebrow="Comms"
        title="Send a notice"
        subtitle="A one-shot email + SMS to one person, a whole role, or the whole team. Recipients without an email or phone on file are skipped (and listed below)."
      />

      <Card className="reveal mt-5 max-w-2xl">
        <CardTitle>New notice</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Sends the same subject + body to each recipient. Each send is logged individually to <code>notifications</code> so you can audit who got what.
        </p>
        <div className="mt-4">
          <SendNoticeForm
            drivers={drivers.map((d) => ({
              id: d.id,
              label: d.full_name,
              has_email: d.has_email,
              has_phone: d.has_phone,
            }))}
            owners={owners.map((o) => ({
              id: o.id,
              label: o.display_name,
              has_email: o.has_email,
              has_phone: o.has_phone,
            }))}
            staff={staff.map((s) => ({
              id: s.id,
              label: s.full_name || s.id,
              has_email: s.has_email,
              has_phone: s.has_phone,
            }))}
          />
        </div>
      </Card>
    </>
  );
}
