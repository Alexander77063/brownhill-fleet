import type { RegionId } from '@/lib/deployment/profile';
import { regionProvider } from '@/lib/region';

// E.164 allows as few as 8 digits, but no mobile in either market is shorter
// than 10 including the country code; a lower floor lets '12345' through as a
// "valid" Nigerian number.
const E164 = /^\+[1-9]\d{9,14}$/;

/**
 * Normalise a typed phone number to E.164, or null if it cannot be one.
 *
 * Phone is an identity key for owners, so every read and write goes through
 * here. International forms are kept; a national form (leading trunk prefix)
 * gets the region's country code. Anything else — letters, too few digits — is
 * refused rather than guessed: a wrong guess signs someone in as someone else.
 */
export function normalisePhone(raw: string, region?: RegionId): string | null {
  const spec = regionProvider(region).phone;
  const compact = raw.replace(/[\s().-]/g, '');
  if (!compact) return null;
  let candidate: string;
  if (compact.startsWith('+')) candidate = compact;
  else if (compact.startsWith('00')) candidate = `+${compact.slice(2)}`;
  else if (/^\d+$/.test(compact)) {
    const national = compact.startsWith(spec.trunkPrefix)
      ? compact.slice(spec.trunkPrefix.length)
      : compact;
    candidate = `${spec.countryCode}${national}`;
  } else return null;
  if (!/^\+\d+$/.test(candidate)) return null;
  return E164.test(candidate) ? candidate : null;
}
