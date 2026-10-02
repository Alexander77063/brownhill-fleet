/** Company lookup by number — the clean, free instance of the "lookup-to-fill"
 *  template. Enter a company number → Companies House returns the legal name +
 *  registered address → onboarding / branding letterhead pre-fills. Dormant until
 *  COMPANIES_HOUSE_API_KEY is set (free key from developer.company-information.service.gov.uk). */
import { LookupNotConfiguredError } from "@/lib/lookups/vehicle";

const CH_URL = "https://api.company-information.service.gov.uk/company";

export interface CompanyLookup {
  companyNumber: string;
  name?: string;
  status?: string;
  address?: string;
}

export function companyLookupConfigured(): boolean {
  return !!process.env.COMPANIES_HOUSE_API_KEY;
}

export async function lookupCompany(number: string): Promise<CompanyLookup | null> {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new LookupNotConfiguredError("Company lookup is not configured on this server.");

  const n = number.replace(/\s+/g, "").toUpperCase();
  if (!n) return null;
  // Companies House uses HTTP Basic with the API key as the username, no password.
  const auth = Buffer.from(`${key}:`).toString("base64");

  const res = await fetch(`${CH_URL}/${encodeURIComponent(n)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Company lookup failed (${res.status}).`);

  const d = (await res.json()) as {
    company_name?: string;
    company_status?: string;
    registered_office_address?: {
      address_line_1?: string;
      address_line_2?: string;
      locality?: string;
      region?: string;
      postal_code?: string;
      country?: string;
    };
  };
  const a = d.registered_office_address ?? {};
  const address = [a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code, a.country]
    .filter(Boolean)
    .join(", ");

  return {
    companyNumber: n,
    name: d.company_name || undefined,
    status: d.company_status || undefined,
    address: address || undefined,
  };
}
