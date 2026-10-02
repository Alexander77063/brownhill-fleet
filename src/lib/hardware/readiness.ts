/**
 * Can this instance run hardware operations? Read by the console banner, the
 * hardware page's Readiness tab and the settings page, so a gateway that is
 * down, an empty stock room or a missing installer is visible everywhere.
 */
import { platformSettings } from '@/lib/collection/settings';
import { deploymentProfile } from '@/lib/deployment/profile';
import { createServiceClient } from '@/lib/supabase/server';
import type { UnitState } from './derive';
import { fittedNotReporting, type JobRow, overdueJobs, type SilentFittedDevice } from './jobs';
import { type Env, traccarClient } from './traccar';
import { listUnits, stockSummary } from './units';

type Sb = ReturnType<typeof createServiceClient>;

export interface HardwareReadiness {
  /** Hardware operations exist on builds with vehicle owners (the managed product). */
  applies: boolean;
  /** No blocking problem: gateway up, someone to fit, something to fit. */
  ok: boolean;
  blocking: string[];
  warnings: string[];
  traccar: { configured: boolean; reachable: boolean | null };
  stock: Record<UnitState, number> & { traccarPending: number };
  byModel: { model: string; inStock: number }[];
  overdue: JobRow[];
  silent: SilentFittedDevice[];
  installers: number;
}

const EMPTY_STOCK = { in_stock: 0, allocated: 0, fitted: 0, faulty: 0, returned: 0, retired: 0, lost: 0, traccarPending: 0 };

export async function hardwareReadiness(sb: Sb = createServiceClient(), env: Env = process.env, today: string = new Date().toISOString().slice(0, 10)): Promise<HardwareReadiness> {
  const applies = deploymentProfile().ownerPortal;
  const none: HardwareReadiness = { applies, ok: true, blocking: [], warnings: [], traccar: { configured: false, reachable: null }, stock: EMPTY_STOCK, byModel: [], overdue: [], silent: [], installers: 0 };
  if (!applies) return none;

  const traccar = traccarClient(env);
  const configured = traccar.configured();
  const [reachable, settings, stock, inStock, overdue, { count: installers }] = await Promise.all([
    configured ? traccar.ping().catch(() => false) : Promise.resolve<boolean | null>(null),
    platformSettings(sb),
    stockSummary(sb),
    listUnits({ state: 'in_stock', limit: 1000 }, sb),
    overdueJobs(today, sb),
    sb.from('installers').select('id', { count: 'exact', head: true }).eq('active', true),
  ]);
  const silent = await fittedNotReporting(settings['hardware.first_ping_hours'], sb);

  const byModelMap = new Map<string, number>();
  for (const u of inStock) byModelMap.set(u.model ?? 'unknown model', (byModelMap.get(u.model ?? 'unknown model') ?? 0) + 1);
  const byModel = [...byModelMap].map(([model, n]) => ({ model, inStock: n })).sort((a, b) => b.inStock - a.inStock);

  const blocking: string[] = [];
  const warnings: string[] = [];
  if (!configured) blocking.push('The tracking gateway is not configured (TRACCAR_URL, TRACCAR_TOKEN, TRACCAR_FORWARD_SECRET).');
  else if (reachable === false) blocking.push('The tracking gateway is not answering.');
  if (!(installers ?? 0)) blocking.push('No active installer — nobody can be booked to fit a tracker.');
  if (stock.in_stock === 0) warnings.push('No units in stock.');
  if (stock.traccarPending > 0) warnings.push(`${stock.traccarPending} unit${stock.traccarPending === 1 ? '' : 's'} awaiting registration with the gateway.`);
  if (overdue.length) warnings.push(`${overdue.length} job${overdue.length === 1 ? '' : 's'} past the fitting SLA.`);
  if (silent.length) warnings.push(`${silent.length} fitted unit${silent.length === 1 ? '' : 's'} never reported a position.`);

  return { applies, ok: blocking.length === 0, blocking, warnings, traccar: { configured, reachable }, stock, byModel, overdue, silent, installers: installers ?? 0 };
}
