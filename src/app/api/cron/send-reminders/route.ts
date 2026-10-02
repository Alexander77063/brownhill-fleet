import { type NextRequest, NextResponse } from 'next/server';
import { sendObligationReminders } from '@/lib/comms';
import { chaseOverdueCharges, checkMileageService, sendRentReminders, sendVehicleDocReminders } from '@/lib/reminders';
import { detectUnauthorisedUse } from '@/lib/tracking-rules';
import { isCronAuthorized } from '@/lib/cron';
import { createServiceClient } from '@/lib/supabase/server';

// Daily notifications sweep for every active tenant: driver-document renewals,
// vehicle-document (MOT/VED) renewals, overdue-charge chases, and rent due/overdue
// reminders. Every send is deduped through the notifications table, so it is safe
// to run daily. Runs after sweep-obligations (07:00) so obligation rows are fresh.
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const sb = createServiceClient();
  const { data: tenants } = await sb.from('tenants').select('id').eq('status', 'active');

  let driverDocs = 0;
  let vehicleDocs = 0;
  let chargeChase = 0;
  let rent = 0;
  let unauthorised = 0;
  let mileageService = 0;
  for (const t of (tenants ?? []) as { id: string }[]) {
    driverDocs += await sendObligationReminders(t.id);
    vehicleDocs += await sendVehicleDocReminders(t.id);
    chargeChase += await chaseOverdueCharges(t.id);
    rent += await sendRentReminders(t.id);
    unauthorised += await detectUnauthorisedUse(t.id);
    mileageService += await checkMileageService(t.id);
  }
  return NextResponse.json({
    ok: true,
    driver_docs: driverDocs,
    vehicle_docs: vehicleDocs,
    charge_chase: chargeChase,
    rent,
    unauthorised_use: unauthorised,
    mileage_service: mileageService,
  });
}
