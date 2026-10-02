/**
 * Can this instance take money? Read by the console banner, the settings page
 * and the cron response, so a misconfigured instance is visible everywhere.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { regionOf } from '@/lib/catalogue/region';
import { payFirst } from '@/lib/region';
import { configuredGateways } from './collector';
import { isUnpriced, isUnpricedItem } from './pricing';
import { issuerReady, platformSettings } from './settings';

type Sb = ReturnType<typeof createServiceClient>;

export interface CollectionReadiness {
  /** False when the market is pay-first and something below is missing. */
  ok: boolean;
  applies: boolean;
  reasons: string[];
  gateways: string[];
  unpriced: string[];
}

export async function collectionReadiness(sb: Sb = createServiceClient()): Promise<CollectionReadiness> {
  const applies = deploymentProfile().subscriptionBilling && payFirst();
  if (!applies) return { ok: true, applies, reasons: [], gateways: [], unpriced: [] };
  const region = deploymentProfile().region;
  const [settings, { data: plans }, { data: items }] = await Promise.all([
    platformSettings(sb),
    sb.from('plans').select('name, base_price_pence, per_vehicle, region, active').eq('active', true),
    sb.from('addons').select('name, unit_price_pence, region, active, kind').eq('active', true).eq('kind', 'one_off'),
  ]);
  const reasons: string[] = [];
  const issuer = issuerReady(settings);
  if (!issuer.ok) reasons.push(`Invoice issuer details missing: ${issuer.missing.join(', ')}.`);
  const gateways = configuredGateways();
  if (gateways.length === 0) reasons.push('No payment gateway is configured (PAYSTACK_SECRET_KEY or FLUTTERWAVE_SECRET_KEY); only bank transfers can be recorded.');
  const unpriced = [
    ...(plans ?? []).filter((p) => regionOf(p) === region && isUnpriced(p)).map((p) => p.name),
    ...(items ?? []).filter((a) => regionOf(a) === region && isUnpricedItem(a)).map((a) => a.name),
  ];
  if (unpriced.length) reasons.push(`Unpriced and active in the catalogue: ${unpriced.join(', ')}.`);
  return { ok: reasons.length === 0, applies, reasons, gateways, unpriced };
}
