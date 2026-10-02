import { type NextRequest, NextResponse } from 'next/server';
import { addDays, daysBetween, isCronAuthorized, todayISO } from '@/lib/cron';
import { rtbEquityAtWeek } from '@/lib/finance';
import { createServiceClient } from '@/lib/supabase/server';

// Weekly cron: accrue rent (rent_schedule + invoice) for every active agreement
// up to the current week, backfilling any missed weeks since start_date, and
// append the RTB equity ledger for rent-to-buy agreements. Fully idempotent.
export const runtime = 'nodejs';

const MAX_WEEKS = 200; // safety cap (RTB term is 156 weeks)

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = createServiceClient();
  const today = todayISO();

  const { data: agreements } = await sb
    .from('agreements')
    .select(
      'id, tenant_id, type, status, start_date, weekly_gross_pence, weekly_net_pence, weekly_vat_pence, deposit_pence, option_credit_weekly_pence',
    )
    .eq('status', 'active');

  type Ag = {
    id: string;
    tenant_id: string;
    type: 'standard' | 'rtb';
    start_date: string | null;
    weekly_gross_pence: number;
    weekly_net_pence: number;
    weekly_vat_pence: number;
    deposit_pence: number;
    option_credit_weekly_pence: number | null;
  };

  let rentRows = 0;
  let invoices = 0;
  let equityRows = 0;

  for (const raw of (agreements ?? []) as Ag[]) {
    if (!raw.start_date) continue;

    // week_no for `today`, anchored to start_date (week 1 = start_date..+6d).
    const elapsed = daysBetween(raw.start_date, today);
    if (elapsed < 0) continue;
    const currentWeek = Math.min(Math.floor(elapsed / 7) + 1, MAX_WEEKS);

    for (let week = 1; week <= currentWeek; week++) {
      const periodStart = addDays(raw.start_date, (week - 1) * 7);
      const periodEnd = addDays(periodStart, 6);

      // 1) rent_schedule (unique agreement_id+week_no). Insert; tolerate dupes.
      let rentScheduleId: string | null = null;
      const { data: rsIns, error: rsErr } = await sb
        .from('rent_schedule')
        .insert({
          // Attribute to the AGREEMENT's tenant. Omitting this is not a no-op:
          // the column defaults to the seed tenant, so every other tenant's rent
          // would silently land in the seed tenant's books.
          tenant_id: raw.tenant_id,
          agreement_id: raw.id,
          week_no: week,
          period_start: periodStart,
          period_end: periodEnd,
          gross_due_pence: raw.weekly_gross_pence,
          net_due_pence: raw.weekly_net_pence,
          vat_due_pence: raw.weekly_vat_pence,
        } as never)
        .select('id')
        .single();

      if (rsErr) {
        if (rsErr.code !== '23505') throw new Error(`rent_schedule: ${rsErr.message}`);
        const { data: existing } = await sb
          .from('rent_schedule')
          .select('id')
          .eq('agreement_id', raw.id)
          .eq('week_no', week)
          .maybeSingle();
        rentScheduleId = (existing as { id: string } | null)?.id ?? null;
      } else {
        rentRows++;
        rentScheduleId = (rsIns as { id: string }).id;
      }

      // 2) Matching invoice with a deterministic number, so re-runs never
      //    double-bill even if a prior run created the schedule but not the
      //    invoice. due_on = the week's period_start.
      const number = `INV-${raw.id.slice(0, 8)}-W${week}`;
      const { error: invErr } = await sb.from('invoices').insert({
        tenant_id: raw.tenant_id,
        agreement_id: raw.id,
        rent_schedule_id: rentScheduleId,
        number,
        issued_on: today,
        due_on: periodStart,
        gross_pence: raw.weekly_gross_pence,
        net_pence: raw.weekly_net_pence,
        vat_pence: raw.weekly_vat_pence,
      } as never);
      if (!invErr) invoices++;
      else if (invErr.code !== '23505') throw new Error(`invoice: ${invErr.message}`);

      // 3) RTB equity ledger row (cumulative option credit + deposit).
      if (raw.type === 'rtb' && raw.option_credit_weekly_pence != null) {
        const eq = rtbEquityAtWeek(
          week,
          raw.option_credit_weekly_pence,
          raw.deposit_pence,
          0, // list value only feeds pctOfVehicle, which we don't persist
        );
        const { error: eqErr } = await sb.from('rtb_equity_ledger').insert({
          tenant_id: raw.tenant_id,
          agreement_id: raw.id,
          week_no: week,
          credit_pence: raw.option_credit_weekly_pence,
          cumulative_credit_pence: eq.cumulativeCreditPence,
          deposit_pence: raw.deposit_pence,
          equity_total_pence: eq.equityTotalPence,
          as_of: periodEnd,
        } as never);
        if (!eqErr) equityRows++;
        else if (eqErr.code !== '23505') throw new Error(`rtb_equity_ledger: ${eqErr.message}`);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    ran_on: today,
    rent_schedule_created: rentRows,
    invoices_created: invoices,
    equity_rows_created: equityRows,
  });
}
