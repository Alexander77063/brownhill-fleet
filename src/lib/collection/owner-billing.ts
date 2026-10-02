/**
 * What the owner portal's billing page needs: who is paying, what they are on,
 * and what they could buy — with a price preview for THEIR vehicles from the
 * same pure pricing the invoice uses.
 */
import { requireRole } from '@/lib/auth';
import { getAuthContext } from '@/lib/auth/context';
import { listCatalogue, listPlanOneOffs } from '@/lib/catalogue/manage';
import { regionOf } from '@/lib/catalogue/region';
import { deploymentProfile, planAudience } from '@/lib/deployment/profile';
import { regionProvider } from '@/lib/region';
import { createServiceClient } from '@/lib/supabase/server';
import { billedVehicleRows, listInvoices, type InvoiceRow } from './invoices';
import { isUnpriced, isUnpricedItem, oneOffLinesFor, subscriptionLines, termEnd, termMonths, totals, type Interval, type OneOffItem, type PriceablePlan } from './pricing';
import type { SubStatus } from './state';

type Sb = ReturnType<typeof createServiceClient>;

export interface OwnerBilling {
  tenantId: string;
  ownerId: string;
  owner: { name: string; phone: string; email: string | null };
  status: SubStatus;
  planId: string | null;
  planName: string | null;
  pendingPlanId: string | null;
  anniversaryOn: string | null;
  billedVehicles: number;
  vehicles: { id: string; registration: string }[];
  invoices: InvoiceRow[];
}

export async function ownerBilling(sb: Sb = createServiceClient()): Promise<OwnerBilling> {
  const p = await requireRole(['owner']);
  const ctx = await getAuthContext();
  if (!ctx?.tenantId || !p.vehicleOwnerId) throw new Error('No owner record is linked to this account.');
  const [{ data: sub }, { data: owner }, vehicles, invoices] = await Promise.all([
    sb.from('tenant_subscription').select('status, plan_id, pending_plan_id, anniversary_on, billed_vehicles, plans(name)').eq('tenant_id', ctx.tenantId).maybeSingle(),
    sb.from('vehicle_owners').select('name, phone, email').eq('id', p.vehicleOwnerId).eq('tenant_id', ctx.tenantId).maybeSingle(),
    billedVehicleRows(ctx.tenantId, sb),
    listInvoices(ctx.tenantId, sb),
  ]);
  const plan = (sub as unknown as { plans: { name: string } | null } | null)?.plans ?? null;
  return {
    tenantId: ctx.tenantId,
    ownerId: p.vehicleOwnerId,
    owner: { name: owner?.name ?? '', phone: owner?.phone ?? '', email: owner?.email ?? null },
    status: ((sub?.status as SubStatus | undefined) ?? 'unpaid') as SubStatus,
    planId: sub?.plan_id ?? null,
    planName: plan?.name ?? null,
    pendingPlanId: (sub as { pending_plan_id?: string | null } | null)?.pending_plan_id ?? null,
    anniversaryOn: sub?.anniversary_on ?? null,
    billedVehicles: sub?.billed_vehicles ?? vehicles.length,
    vehicles,
    invoices,
  };
}

export interface PlanOffer {
  plan: PriceablePlan & { interval: Interval };
  termLabel: string;
  perVehicleMinor: number;
  features: string[];
  oneOffs: OneOffItem[];
  /** For the owner's current vehicles: net, VAT, gross for the first term incl. hardware. */
  preview: { netMinor: number; vatMinor: number; grossMinor: number } | null;
  currency: string;
}

const TERM_LABEL: Record<Interval, string> = { month: 'per month', half_year: 'per 6 months', year: 'per year' };

/** Every plan this instance sells to individuals that is active and priced, with a preview for these vehicles. */
export async function ownerPlanOffers(vehicles: { id: string; registration: string }[], sb: Sb = createServiceClient()): Promise<PlanOffer[]> {
  const region = deploymentProfile().region;
  const pack = regionProvider(region);
  const [{ plans, addons }, { data: pf }, oneOffsOf] = await Promise.all([
    listCatalogue(sb, { region, audience: planAudience() }),
    sb.from('plan_features').select('plan_id, feature_key'),
    listPlanOneOffs(sb),
  ]);
  const features = new Map<string, string[]>();
  for (const r of pf ?? []) features.set(r.plan_id, [...(features.get(r.plan_id) ?? []), r.feature_key]);
  const itemById = new Map(addons.filter((a) => a.kind === 'one_off').map((a) => [a.id, a]));
  const out: PlanOffer[] = [];
  for (const p of plans) {
    if (!p.active || !p.per_vehicle || isUnpriced(p) || regionOf(p) !== region) continue;
    const plan = { ...p, interval: p.interval as Interval };
    const oneOffs = [...(oneOffsOf.get(p.id) ?? [])].map((id) => itemById.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a && a.active));
    let preview: PlanOffer['preview'] = null;
    if (vehicles.length && oneOffs.every((a) => !isUnpricedItem(a))) {
      const period = { start: '2000-01-01', end: termEnd('2000-01-01', plan.interval) };
      preview = totals([...subscriptionLines(plan, vehicles, period, pack.tax.vatRate), ...oneOffLinesFor(oneOffs, vehicles, pack.tax.vatRate)]);
    }
    out.push({ plan, termLabel: TERM_LABEL[plan.interval], perVehicleMinor: p.base_price_pence, features: features.get(p.id) ?? [], oneOffs, preview, currency: pack.currency.code });
  }
  // Longer terms first within a tier; tiers by catalogue sort.
  return out.sort((a, b) => (a.plan as { sort?: number }).sort! - (b.plan as { sort?: number }).sort! || termMonths(b.plan.interval) - termMonths(a.plan.interval));
}
