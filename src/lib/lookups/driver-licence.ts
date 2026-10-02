/** Driver-licence lookup (DVLA Access to Driver Data). Dormant, and note the
 *  consent requirement: DVLA ADD returns a licence's categories/endorsements only
 *  WITH the driver's one-time CHECK CODE from the "Share Driving Licence" service
 *  (gov.uk/view-driving-licence) plus the last 8 chars of the licence number.
 *  So this template needs both the key AND a check code — not a bare number.
 *  Same "lookup-to-fill" shape as vehicle/company. */
import { LookupNotConfiguredError } from "@/lib/lookups/vehicle";

const DVLA_ADD_URL = "https://driver-vehicle-licensing.api.gov.uk/access-to-driver-data/v1/driving-licences/enquiry";

export interface DriverLicenceLookup {
  licenceNumber: string;
  validFrom?: string;
  validTo?: string;
  categories?: string[];
  endorsements?: number;
  status?: string;
}

export function driverLicenceLookupConfigured(): boolean {
  return !!process.env.DVLA_ADD_API_KEY;
}

export async function lookupDriverLicence(
  drivingLicenceNumber: string,
  checkCode: string,
): Promise<DriverLicenceLookup | null> {
  const key = process.env.DVLA_ADD_API_KEY;
  if (!key) throw new LookupNotConfiguredError("Driver-licence lookup is not configured on this server.");
  if (!checkCode.trim()) {
    throw new Error("A DVLA check code (from the driver's 'Share Driving Licence' service) is required.");
  }

  const res = await fetch(DVLA_ADD_URL, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      drivingLicenceNumber: drivingLicenceNumber.replace(/\s+/g, "").toUpperCase(),
      checkCode: checkCode.replace(/\s+/g, "").toUpperCase(),
      acceptPartialResponse: "false",
    }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Driver-licence lookup failed (${res.status}).`);

  const d = (await res.json()) as {
    driver?: { drivingLicenceNumber?: string };
    licence?: { status?: string; type?: string };
    entitlement?: { categoryCode?: string }[];
    endorsements?: unknown[];
    validFromDate?: string;
    validToDate?: string;
  };
  return {
    licenceNumber: d.driver?.drivingLicenceNumber ?? drivingLicenceNumber,
    validFrom: d.validFromDate,
    validTo: d.validToDate,
    categories: (d.entitlement ?? []).map((e) => e.categoryCode ?? "").filter(Boolean),
    endorsements: Array.isArray(d.endorsements) ? d.endorsements.length : undefined,
    status: d.licence?.status,
  };
}
