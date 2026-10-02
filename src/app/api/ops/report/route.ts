import { type NextRequest, NextResponse } from "next/server";
import { requireTenantContext } from "@/lib/auth/context";
import { generateReport, isReportType } from "@/lib/ops/reports-ai";
import { AssistantNotReadyError } from "@/lib/ops/assistant";

// Tenant-authed on-demand report generation. Grounds the tenant's own AI in their
// live data. 503 when the tenant's AI isn't set up (dormant-safe).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireTenantContext();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { type?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const type = String(body.type ?? "");
  if (!isReportType(type)) return NextResponse.json({ error: "Unknown report type." }, { status: 400 });

  try {
    const report = await generateReport(type);
    return NextResponse.json({ report });
  } catch (err) {
    if (err instanceof AssistantNotReadyError) {
      return NextResponse.json({ error: err.message, ready: false }, { status: 503 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "report failed" }, { status: 500 });
  }
}
