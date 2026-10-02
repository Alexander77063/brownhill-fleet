import { type NextRequest, NextResponse } from "next/server";
import { requireTenantContext } from "@/lib/auth/context";
import { lookupDriverLicence } from "@/lib/lookups/driver-licence";
import { LookupNotConfiguredError } from "@/lib/lookups/vehicle";

// POST because the DVLA check code + licence number are sensitive (kept out of URLs).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireTenantContext();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { licence?: unknown; checkCode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const licence = String(body.licence ?? "").trim();
  const checkCode = String(body.checkCode ?? "").trim();
  if (!licence) return NextResponse.json({ error: "A licence number is required." }, { status: 400 });
  try {
    const driver = await lookupDriverLicence(licence, checkCode);
    if (!driver) return NextResponse.json({ error: "No record for that licence." }, { status: 404 });
    return NextResponse.json({ driver });
  } catch (err) {
    if (err instanceof LookupNotConfiguredError) {
      return NextResponse.json({ error: err.message, configured: false }, { status: 503 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "lookup failed" }, { status: 400 });
  }
}
