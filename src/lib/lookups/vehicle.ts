/** Vehicle lookup by registration — the first instance of the "lookup-to-fill"
 *  template. Enter a VRM, get the DVLA's record (make/colour/fuel/year/CO2), and
 *  the entry form pre-fills. Dormant like the other integrations: without
 *  DVLA_VES_API_KEY it reports "not configured" and the admin enters details
 *  manually. (Model isn't in the DVLA feed, so that field stays manual.)
 *
 *  Copy this shape for the other lookups: company-number → Companies House,
 *  postcode → address, driving-licence → DVLA (with the driver's consent code).
 */

const DVLA_URL =
  "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";

export type FuelKind = "phev" | "ev" | "petrol" | "diesel" | "hybrid";

export interface VehicleLookup {
  registration: string;
  make?: string;
  colour?: string;
  fuel?: FuelKind;
  modelYear?: number;
  co2?: number;
}

export class LookupNotConfiguredError extends Error {
  constructor(message = "Vehicle lookup is not configured on this server.") {
    super(message);
    this.name = "LookupNotConfiguredError";
  }
}

export function vehicleLookupConfigured(): boolean {
  return !!process.env.DVLA_VES_API_KEY;
}

/** Map the DVLA fuelType string onto our fuel_type enum (best effort). */
function mapFuel(raw?: string): FuelKind | undefined {
  if (!raw) return undefined;
  const s = raw.toUpperCase();
  if (s.includes("PLUG") || (s.includes("PETROL") && s.includes("ELECTRIC"))) return "phev";
  if (s === "ELECTRICITY" || s === "ELECTRIC") return "ev";
  if (s.includes("HYBRID")) return "hybrid";
  if (s.includes("DIESEL")) return "diesel";
  if (s.includes("PETROL")) return "petrol";
  return undefined;
}

/** Look up a UK registration. Returns null if the DVLA has no record; throws
 *  LookupNotConfiguredError when dormant so the route can surface a clean state. */
export async function lookupVehicleByReg(reg: string): Promise<VehicleLookup | null> {
  const key = process.env.DVLA_VES_API_KEY;
  if (!key) throw new LookupNotConfiguredError();

  const registrationNumber = reg.replace(/\s+/g, "").toUpperCase();
  if (!registrationNumber) return null;

  const res = await fetch(DVLA_URL, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ registrationNumber }),
  });

  if (res.status === 404) return null; // no DVLA record for this plate
  if (!res.ok) throw new Error(`Vehicle lookup failed (${res.status}).`);

  const d = (await res.json()) as {
    registrationNumber?: string;
    make?: string;
    colour?: string;
    fuelType?: string;
    yearOfManufacture?: number;
    co2Emissions?: number;
  };

  return {
    registration: d.registrationNumber ?? registrationNumber,
    make: d.make || undefined,
    colour: d.colour || undefined,
    fuel: mapFuel(d.fuelType),
    modelYear: typeof d.yearOfManufacture === "number" ? d.yearOfManufacture : undefined,
    co2: typeof d.co2Emissions === "number" ? d.co2Emissions : undefined,
  };
}
