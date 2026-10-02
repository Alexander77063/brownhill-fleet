/**
 * Region registry.
 *
 * `regionProvider()` with no argument returns the pack for the active
 * deployment profile — that is the form application code should use. Passing an
 * explicit id is for tests, and for cross-region tooling in the platform
 * console where one operator looks at instances in several countries.
 */
import { deploymentProfile, type RegionId } from '@/lib/deployment/profile';
import { NG } from './ng';
import { UK } from './uk';
import type { RegionProvider } from './types';

export const REGIONS: Record<RegionId, RegionProvider> = { uk: UK, ng: NG };

export function regionProvider(id?: RegionId): RegionProvider {
  return REGIONS[id ?? deploymentProfile().region];
}

/**
 * Is this market pay-first — "nothing works until money is received"? Derived
 * from the pack's `billing.initialStatus`, so callers ask a question about the
 * market rather than comparing region ids (region-encapsulation test).
 */
export function payFirst(id?: RegionId): boolean {
  return regionProvider(id).billing.initialStatus === 'unpaid';
}

export type {
  BillingSpec,
  CurrencySpec,
  IdentityVerificationSpec,
  ObligationCadence,
  ObligationSpec,
  PaymentProviderId,
  PhoneSpec,
  RegionProvider,
  RoadChargeSpec,
  SmsProviderId,
  TaxRegime,
  VehicleLookupSpec,
} from './types';
