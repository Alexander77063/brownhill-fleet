/**
 * Which modules a build gets from its profile alone.
 *
 * Under the subscription profiles (`saas`, `managed`, `managed-shared`) this is
 * deliberately empty: entitlements come from what the tenant bought, and
 * granting features by profile there would silently bypass the catalogue and
 * hand out features nobody paid for. Under `standalone` there is no
 * subscription to read — we install those customers by hand — so the profile
 * itself is the grant source.
 *
 * This pairs with, and does not replace, the entitlements engine: the engine
 * still unions plan features, bundled add-ons and enabled add-ons. This is one
 * more source in that union, used only where a subscription does not exist.
 */
import type { FeatureKey } from '@/lib/entitlements/features';
import { deploymentProfile, type ProfileId } from './profile';

export const PROFILE_MODULES: Record<ProfileId, readonly FeatureKey[]> = {
  // Entitlements come from the subscription. Never from the profile.
  saas: [],

  // Brownhill: a UK PCO chauffeur-vehicle rental business running the system on
  // their own machine. Fleet core plus the full rental/hire module, plus the
  // compliance and comms they operate on today.
  standalone: [
    'fleet.core',
    'rental.core',
    'compliance',
    'documents',
    'contracts',
    'charges.reconciliation',
    'reports.director',
    'notifications.email',
    'notifications.sms',
    'gps.phone',
    'booking.b2b',
  ],

  // Nigeria (a fleet or an insurer on its own instance). Nothing by profile:
  // the tenant bought Standard, Gold or Platinum, and the catalogue — editable
  // in the platform console — is the only thing that says what that includes.
  // A grant here would hand every Nigerian install Gold's fuel module for free
  // and leave the console unable to take it back.
  managed: [],

  // The shared Nigerian instance for individual owners. Same reasoning.
  'managed-shared': [],
};

/** True when the profile itself grants `key`, independent of any subscription. */
export function profileGrantsFeature(key: FeatureKey, profile?: ProfileId): boolean {
  const id = profile ?? deploymentProfile().id;
  return PROFILE_MODULES[id].includes(key);
}
