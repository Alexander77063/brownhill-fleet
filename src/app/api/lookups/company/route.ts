import { type NextRequest, NextResponse } from "next/server";
import { requireTenantContext } from "@/lib/auth/context";
import { lookupCompany } from "@/lib/lookups/company";
import { LookupNotConfiguredError } from "@/lib/lookups/vehicle";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireTenantContext();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const number = (req.nextUrl.searchParams.get("number") ?? "").trim();
  if (!number) return NextResponse.json({ error: "A company number is required." }, { status: 400 });
  try {
    const company = await lookupCompany(number);
    if (!company) return NextResponse.json({ error: "No company found for that number." }, { status: 404 });
    return NextResponse.json({ company });
  } catch (err) {
    if (err instanceof LookupNotConfiguredError) {
      return NextResponse.json({ error: err.message, configured: false }, { status: 503 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "lookup failed" }, { status: 500 });
  }
}
