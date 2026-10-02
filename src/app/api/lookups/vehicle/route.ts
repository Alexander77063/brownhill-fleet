import { type NextRequest, NextResponse } from "next/server";
import { requireTenantContext } from "@/lib/auth/context";
import { lookupVehicleByReg, LookupNotConfiguredError } from "@/lib/lookups/vehicle";

// Tenant-authed vehicle lookup for the "enter reg → auto-fill" entry pattern.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireTenantContext();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reg = (req.nextUrl.searchParams.get("reg") ?? "").trim();
  if (!reg) return NextResponse.json({ error: "A registration is required." }, { status: 400 });

  try {
    const result = await lookupVehicleByReg(reg);
    if (!result) return NextResponse.json({ error: "No DVLA record for that registration." }, { status: 404 });
    return NextResponse.json({ vehicle: result });
  } catch (err) {
    if (err instanceof LookupNotConfiguredError) {
      return NextResponse.json({ error: err.message, configured: false }, { status: 503 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "lookup failed" }, { status: 500 });
  }
}
