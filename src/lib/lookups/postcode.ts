/** Postcode → address lookup (getAddress.io). Dormant until GETADDRESS_API_KEY is
 *  set — house-level address lookup needs a keyed provider (unlike free
 *  postcode-area data). Same "lookup-to-fill" template as vehicle/company. */
import { LookupNotConfiguredError } from "@/lib/lookups/vehicle";

export interface AddressLookup {
  postcode: string;
  addresses: string[];
}

export function postcodeLookupConfigured(): boolean {
  return !!process.env.GETADDRESS_API_KEY;
}

export async function lookupPostcode(postcode: string): Promise<AddressLookup | null> {
  const key = process.env.GETADDRESS_API_KEY;
  if (!key) throw new LookupNotConfiguredError("Address lookup is not configured on this server.");

  const pc = postcode.replace(/\s+/g, "").toUpperCase();
  if (!pc) return null;

  const res = await fetch(
    `https://api.getAddress.io/find/${encodeURIComponent(pc)}?api-key=${encodeURIComponent(key)}&expand=false`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Address lookup failed (${res.status}).`);

  const d = (await res.json()) as { addresses?: string[] };
  const addresses = (d.addresses ?? [])
    .map((a) => a.replace(/,\s*,/g, ", ").replace(/(^,|,$)/g, "").trim())
    .filter(Boolean);
  return { postcode: pc, addresses };
}
