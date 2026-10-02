/**
 * Reminders — the automated chase engine (Workstream B). Per-tenant functions the
 * daily notifications cron runs: chase overdue charges until settled, remind
 * drivers of rent coming due / overdue, and alert the operator to vehicle
 * documents (MOT/VED) approaching expiry. Every send is deduped through the
 * `notifications` table, so a daily run never spams — a fresh dedupe key is only
 * minted when the escalation level changes.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { notifyDriverLogged, notifyTenantOwner } from '@/lib/comms';
import { addDays, daysBetween, todayISO } from '@/lib/cron';

// Canonical open (unsettled) charge statuses — mirrors reconciliation.ts.
const OPEN_CHARGE_STATUSES = ['received', 'driver_notified', 'driver_liable', 'disputed'] as const;

function poundsStr(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Escalation bucket — a fresh dedupe key is claimed as an item ages. */
function overdueBucket(daysOverdue: number): 'first' | 'second' | 'final' {
  if (daysOverdue >= 14) return 'final';
  if (daysOverdue >= 7) return 'second';
  return 'first';
}

/**
 * Chase open charges whose 48h report window has passed. The liable driver is
 * re-notified at escalating intervals; unassigned overdue charges nudge the
 * operator to assign them. Returns how many new reminders were queued.
 */
export async function chaseOverdueCharges(tenantId: string): Promise<number> {
  const sb = createServiceClient();
  const nowIso = new Date().toISOString();
  const { data } = await sb
    .from('charges')
    .select('id, driver_id, amount_pence, authority, type, report_due_at, vehicles(registration)')
    .eq('tenant_id', tenantId)
    .in('status', [...OPEN_CHARGE_STATUSES])
    .not('report_due_at', 'is', null)
    .lt('report_due_at', nowIso);

  const today = todayISO();
  let queued = 0;
  for (const c of (data ?? []) as {
    id: string;
    driver_id: string | null;
    amount_pence: number;
    authority: string | null;
    type: string;
    report_due_at: string;
    vehicles: { registration: string } | null;
  }[]) {
    const daysOverdue = Math.max(0, daysBetween(c.report_due_at.slice(0, 10), today));
    const bucket = overdueBucket(daysOverdue);
    const label = c.authority ?? c.type;
    const reg = c.vehicles?.registration ?? 'your vehicle';

    if (c.driver_id) {
      const r = await notifyDriverLogged(
        tenantId,
        c.driver_id,
        `Reminder: unpaid ${label} charge — ${poundsStr(c.amount_pence)}`,
        `The ${label} charge on ${reg} for ${poundsStr(c.amount_pence)} is still outstanding. Please settle it and confirm with the office.`,
        { entityType: 'charge', entityId: c.id, dedupeKey: `charge_chase:${c.id}:${bucket}` },
      );
      if (r.logged) queued++;
    } else {
      const r = await notifyTenantOwner(
        tenantId,
        `Unassigned charge overdue — ${poundsStr(c.amount_pence)}`,
        `A ${label} charge on ${reg} for ${poundsStr(c.amount_pence)} is past its 48h window with no driver assigned. Assign it to recover the cost.`,
        { entityType: 'charge', entityId: c.id, dedupeKey: `charge_unassigned:${c.id}:${bucket}` },
      );
      if (r.logged) queued++;
    }
  }
  return queued;
}

/**
 * Remind drivers of rent coming due within `dueWithinDays` and rent already
 * overdue. Invoices carry no driver — resolved through the agreement. Deduped per
 * invoice (upcoming fires once; overdue re-fires as it ages).
 */
export async function sendRentReminders(tenantId: string, dueWithinDays = 3): Promise<number> {
  const sb = createServiceClient();
  const today = todayISO();
  const horizon = addDays(today, dueWithinDays);
  const { data } = await sb
    .from('invoices')
    .select('id, number, due_on, gross_pence, agreements(driver_id)')
    .eq('tenant_id', tenantId)
    .in('status', ['open', 'part_paid'])
    .lte('due_on', horizon);

  let queued = 0;
  for (const inv of (data ?? []) as {
    id: string;
    number: string | null;
    due_on: string;
    gross_pence: number;
    agreements: { driver_id: string } | null;
  }[]) {
    const driverId = inv.agreements?.driver_id;
    if (!driverId) continue;
    const overdue = inv.due_on < today;
    const label = inv.number ?? inv.id;
    const dedupeKey = overdue
      ? `rent_overdue:${inv.id}:${overdueBucket(Math.max(0, daysBetween(inv.due_on, today)))}`
      : `rent_due:${inv.id}`;
    const subject = overdue
      ? `Overdue rent — ${poundsStr(inv.gross_pence)}`
      : `Rent due ${inv.due_on} — ${poundsStr(inv.gross_pence)}`;
    const body = overdue
      ? `Your rent of ${poundsStr(inv.gross_pence)} (invoice ${label}) was due on ${inv.due_on} and is now overdue. Please pay to keep your agreement in good standing.`
      : `Your rent of ${poundsStr(inv.gross_pence)} (invoice ${label}) is due on ${inv.due_on}.`;
    const r = await notifyDriverLogged(tenantId, driverId, subject, body, {
      entityType: 'invoice',
      entityId: inv.id,
      dedupeKey,
    });
    if (r.logged) queued++;
  }
  return queued;
}

/**
 * Nudge the operator when a vehicle is due a service by mileage — the latest
 * odometer has reached last-service + interval. Complements the date-based
 * service schedule. Deduped per vehicle + month, so it re-nudges monthly until
 * the service is recorded (which advances last_service_miles).
 */
export async function checkMileageService(tenantId: string): Promise<number> {
  const sb = createServiceClient();
  const { data: vehicles } = await sb
    .from('vehicles')
    .select('id, registration, service_interval_miles, last_service_miles')
    .eq('tenant_id', tenantId)
    .not('service_interval_miles', 'is', null);

  const month = todayISO().slice(0, 7);
  let queued = 0;
  for (const v of (vehicles ?? []) as {
    id: string;
    registration: string;
    service_interval_miles: number | null;
    last_service_miles: number | null;
  }[]) {
    if (!v.service_interval_miles) continue;
    const { data: pos } = await sb
      .from('vehicle_positions')
      .select('odometer_miles')
      .eq('vehicle_id', v.id)
      .maybeSingle();
    const odo = (pos as { odometer_miles: number | null } | null)?.odometer_miles;
    if (odo == null) continue;

    const dueAt = (v.last_service_miles ?? 0) + v.service_interval_miles;
    if (odo >= dueAt) {
      const r = await notifyTenantOwner(
        tenantId,
        `Service due (mileage) — ${v.registration}`,
        `${v.registration} has reached ${odo.toLocaleString()} miles (service due at ${dueAt.toLocaleString()}). Book it in, then record the service to reset the counter.`,
        { entityType: 'vehicle', entityId: v.id, dedupeKey: `mileage_service:${v.id}:${month}` },
      );
      if (r.logged) queued++;
    }
  }
  return queued;
}

/**
 * Alert the operator to vehicle documents (MOT / VED) that are due soon or
 * overdue. Vehicles have no contact fields, so these go to the tenant owner.
 * Deduped per obligation + severity, so escalation fires once per level.
 */
export async function sendVehicleDocReminders(tenantId: string): Promise<number> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('obligations')
    .select('id, entity_id, type, title, due_date, status, severity')
    .eq('tenant_id', tenantId)
    .eq('entity_type', 'vehicle')
    .in('type', ['mot', 'ved_renewal'])
    .in('status', ['due_soon', 'overdue']);

  let queued = 0;
  for (const o of (data ?? []) as {
    id: string;
    entity_id: string;
    type: string;
    title: string;
    due_date: string;
    status: string;
    severity: string;
  }[]) {
    const { data: veh } = await sb
      .from('vehicles')
      .select('registration')
      .eq('id', o.entity_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const reg = (veh as { registration: string } | null)?.registration ?? 'a vehicle';
    const label = o.type === 'mot' ? 'MOT' : 'VED / road tax';
    const subject =
      o.status === 'overdue' ? `Overdue: ${label} — ${reg}` : `${label} due ${o.due_date} — ${reg}`;
    const body = `${reg}: ${o.title} (${label}) is ${
      o.status === 'overdue' ? 'overdue' : `due on ${o.due_date}`
    }. Please renew to keep the vehicle compliant.`;
    const r = await notifyTenantOwner(tenantId, subject, body, {
      entityType: 'obligation',
      entityId: o.id,
      dedupeKey: `vehicle_doc:${o.id}:${o.severity}`,
    });
    if (r.logged) queued++;
  }
  return queued;
}
