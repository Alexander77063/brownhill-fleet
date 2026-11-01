/**
 * The rent-to-buy book, read from the database.
 *
 * Two readers, two trust levels:
 *
 *   assembleRtbReport()        — the board's book. A service-role read scoped
 *                                 to one tenant, with the rentee's name on it.
 *
 *   assembleInvestorRtbReport() — the investor's book. A session read of the
 *                                 PII-free `v_investor_rtb` view, so the
 *                                 database decides what the investor may see.
 *                                 No names, no addresses, no rent rates.
 *
 * Both return the same shape and are priced by the same engine, so the number
 * a director reads is the number an investor reads — the investor simply sees
 * fewer of the columns.
 */

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { requireTenantContext } from '@/lib/auth/context';
import { getTenant } from '@/lib/tenancy';
import {
  anonymiseRtbReport,
  resolveRtbCost,
  rtbDealEconomics,
  rtbPortfolio,
  type RtbAudience,
  type RtbDealRow,
  type RtbDealSource,
  type RtbReport,
} from '@/lib/reports/rtb';

export type { RtbAudience, RtbReport } from '@/lib/reports/rtb';

/** The agreement columns the book is priced from. */
const AGREEMENT_COLUMNS =
  'id, vehicle_id, driver_id, status, start_date, term_weeks, weekly_gross_pence, weekly_net_pence, weekly_vat_pence, deposit_pence, option_credit_weekly_pence, agreed_residual_pence, term_months, monthly_gross_pence, agreed_vehicle_price_pence, agreed_vehicle_cost_pence';

/* ── The board's book ─────────────────────────────────────────────────────── */

/**
 * The whole rent-to-buy book for one tenant, priced.
 *
 * Service-role, so every read is scoped to `tenant_id` in application code —
 * the same invariant every other service-role call in the app keeps.
 */
export async function assembleRtbReport(tenantId: string): Promise<RtbReport> {
  const sb = createServiceClient();

  const { data: agreementRows } = await sb
    .from('agreements')
    .select(AGREEMENT_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('type', 'rtb');

  const rows = (agreementRows ?? []) as Array<{
    id: string;
    vehicle_id: string;
    driver_id: string;
    status: string;
    start_date: string | null;
    term_weeks: number | null;
    weekly_gross_pence: number;
    weekly_net_pence: number;
    weekly_vat_pence: number;
    deposit_pence: number;
    option_credit_weekly_pence: number | null;
    agreed_residual_pence: number | null;
    term_months: number | null;
    monthly_gross_pence: number | null;
    agreed_vehicle_price_pence: number | null;
    agreed_vehicle_cost_pence: number | null;
  }>;

  if (rows.length === 0) {
    const tenant = await getTenant(tenantId);
    return {
      audience: 'board',
      tenantName: tenant?.name ?? 'the fleet',
      generatedAt: new Date().toISOString(),
      rows: [],
      totals: rtbPortfolio([]),
    };
  }

  const vehicleIds = unique(rows.map((r) => r.vehicle_id));
  const driverIds = unique(rows.map((r) => r.driver_id));

  const [vehicles, drivers, finance] = await Promise.all([
    sb
      .from('vehicles')
      .select('id, registration, list_value_pence')
      .in('id', vehicleIds),
    sb.from('drivers').select('id, full_name').in('id', driverIds),
    // The funder's invoice: the initial rental plus what was financed. It is
    // the second-best record of what a car cost — the first is the agreed
    // cost on the agreement itself.
    sb
      .from('finance_agreements')
      .select('vehicle_id, initial_rental_pence, amount_financed_pence, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }),
  ]);

  const vehicleById = new Map(
    ((vehicles.data ?? []) as Array<{
      id: string;
      registration: string | null;
      list_value_pence: number | null;
    }>).map((v) => [v.id, v]),
  );
  const driverById = new Map(
    ((drivers.data ?? []) as Array<{ id: string; full_name: string | null }>).map(
      (d) => [d.id, d],
    ),
  );

  // The most recent funder invoice per car, matching the view's lateral join.
  const funderByVehicle = new Map<
    string,
    { initial_rental_pence: number; amount_financed_pence: number | null }
  >();
  for (const fa of (finance.data ?? []) as Array<{
    vehicle_id: string;
    initial_rental_pence: number;
    amount_financed_pence: number | null;
    created_at: string;
  }>) {
    if (funderByVehicle.has(fa.vehicle_id)) continue;
    funderByVehicle.set(fa.vehicle_id, {
      initial_rental_pence: fa.initial_rental_pence,
      amount_financed_pence: fa.amount_financed_pence,
    });
  }

  const deals: RtbDealRow[] = rows.map((r) => {
    const vehicle = vehicleById.get(r.vehicle_id);
    const funder = funderByVehicle.get(r.vehicle_id);
    const funderCostPence = funder
      ? funder.initial_rental_pence + (funder.amount_financed_pence ?? 0)
      : null;

    const cost = resolveRtbCost({
      agreedVehicleCostPence: r.agreed_vehicle_cost_pence,
      funderCostPence,
      listValuePence: vehicle?.list_value_pence ?? null,
    });

    const source: RtbDealSource = {
      agreementId: r.id,
      vehicleId: r.vehicle_id,
      registration: vehicle?.registration ?? null,
      driverName: driverById.get(r.driver_id)?.full_name ?? null,
      status: r.status,
      startDate: r.start_date,
      termWeeks: r.term_weeks ?? 0,
      weeklyGrossPence: r.weekly_gross_pence,
      weeklyNetPence: r.weekly_net_pence,
      weeklyVatPence: r.weekly_vat_pence,
      depositPence: r.deposit_pence,
      optionCreditWeeklyPence: r.option_credit_weekly_pence ?? 0,
      agreedResidualPence: r.agreed_residual_pence ?? 0,
      termMonths: r.term_months ?? 0,
      monthlyGrossPence: r.monthly_gross_pence ?? 0,
      agreedVehiclePricePence: r.agreed_vehicle_price_pence,
      listValuePence: vehicle?.list_value_pence ?? null,
      carCostPence: cost.costPence,
      costBasis: cost.basis,
    };
    return rtbDealEconomics(source);
  });

  const tenant = await getTenant(tenantId);
  return {
    audience: 'board',
    tenantName: tenant?.name ?? 'the fleet',
    generatedAt: new Date().toISOString(),
    rows: deals,
    totals: rtbPortfolio(deals),
  };
}

/* ── The investor's book ──────────────────────────────────────────────────── */

/**
 * The rent-to-buy book as an investor may read it.
 *
 * The read goes through `v_investor_rtb`, which is the database's own answer to
 * "what may this investor see": the tenant filter and the role guard live in
 * the view, and the rentee's identity is not in it at all.
 */
export async function assembleInvestorRtbReport(): Promise<RtbReport> {
  const ctx = await requireTenantContext();
  const sb = await createClient();

  const { data } = await sb.from('v_investor_rtb').select('*');

  const rows = (data ?? []) as Array<{
    agreement_id: string;
    vehicle_id: string;
    registration: string | null;
    status: string;
    start_date: string | null;
    term_weeks: number | null;
    term_months: number | null;
    monthly_gross_pence: number | null;
    weekly_gross_pence: number;
    weekly_net_pence: number;
    weekly_vat_pence: number;
    deposit_pence: number;
    option_credit_weekly_pence: number | null;
    agreed_residual_pence: number | null;
    agreed_vehicle_price_pence: number | null;
    list_value_pence: number | null;
    car_cost_pence: number | null;
    cost_basis: 'deal' | 'funder' | 'list';
  }>;

  const deals: RtbDealRow[] = rows.map((r) => {
    const source: RtbDealSource = {
      agreementId: r.agreement_id,
      vehicleId: r.vehicle_id,
      registration: r.registration,
      // The rentee's identity is not the investor's business.
      driverName: null,
      status: r.status,
      startDate: r.start_date,
      termWeeks: r.term_weeks ?? 0,
      weeklyGrossPence: r.weekly_gross_pence,
      weeklyNetPence: r.weekly_net_pence,
      weeklyVatPence: r.weekly_vat_pence,
      depositPence: r.deposit_pence,
      optionCreditWeeklyPence: r.option_credit_weekly_pence ?? 0,
      agreedResidualPence: r.agreed_residual_pence ?? 0,
      termMonths: r.term_months ?? 0,
      monthlyGrossPence: r.monthly_gross_pence ?? 0,
      agreedVehiclePricePence: r.agreed_vehicle_price_pence,
      listValuePence: r.list_value_pence,
      carCostPence: r.car_cost_pence,
      costBasis: r.cost_basis,
    };
    return rtbDealEconomics(source);
  });

  const tenant = await getTenant(ctx.tenantId);
  return {
    audience: 'investor',
    tenantName: tenant?.name ?? 'the fleet',
    generatedAt: new Date().toISOString(),
    rows: deals,
    totals: rtbPortfolio(deals),
  };
}

/* ── Choosing the book a reader may see ──────────────────────────────────── */

/**
 * The rent-to-buy book as a given audience may read it.
 *
 * The board reads the whole book. An investor reads the same figures without
 * the rentee's names — through the `v_investor_rtb` view, which is the
 * database's own answer to what an investor may see, and the only book an
 * investor can read at all.
 *
 * A director is not an investor, so the view does not open for them. When the
 * view yields nothing and the board's book does not, the board's book is
 * returned with the names stripped: the same report, one column blank, so what
 * the board previews is what the investors receive.
 */
export async function assembleRtbReportFor(
  tenantId: string,
  audience: RtbAudience,
): Promise<RtbReport> {
  if (audience === 'board') return assembleRtbReport(tenantId);

  const viewed = await assembleInvestorRtbReport().catch(() => null);
  if (viewed && viewed.rows.length > 0) return viewed;

  const board = await assembleRtbReport(tenantId);
  if (board.rows.length > 0) return anonymiseRtbReport(board);
  return viewed ?? board;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
