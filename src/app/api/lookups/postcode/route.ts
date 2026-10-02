import { type NextRequest, NextResponse } from "next/server";
import { requireTenantContext } from "@/lib/auth/context";
import { lookupPostcode } from "@/lib/lookups/postcode";
import { LookupNotConfiguredError } from "@/lib/lookups/vehicle";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireTenantContext();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const postcode = (req.nextUrl.searchParams.get("postcode") ?? "").trim();
  if (!postcode) return NextResponse.json({ error: "A postcode is required." }, { status: 400 });
  try {
    const result = await lookupPostcode(postcode);
    if (!result) return NextResponse.json({ error: "No addresses for that postcode." }, { status: 404 });
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof LookupNotConfiguredError) {
      return NextResponse.json({ error: err.message, configured: false }, { status: 503 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "lookup failed" }, { status: 500 });
  }
}
