import { type NextRequest, NextResponse } from "next/server";
import { requireTenantContext } from "@/lib/auth/context";
import { askTenantAssistant, AssistantNotReadyError } from "@/lib/ops/assistant";
import type { AiMessage } from "@/lib/ai/providers";

// Per-tenant Fleet Assistant. Auth = the caller's tenant session (RLS); the
// assistant only ever grounds in this tenant's own data. Distinct from the
// platform copilot at /api/platform/copilot (which is platform-admin only).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireTenantContext();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { question?: unknown; history?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const question = String(body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "A question is required." }, { status: 400 });
  const history = Array.isArray(body.history) ? (body.history as AiMessage[]).slice(-10) : [];

  try {
    const answer = await askTenantAssistant(question, history);
    return NextResponse.json({ answer });
  } catch (err) {
    if (err instanceof AssistantNotReadyError) {
      return NextResponse.json({ error: err.message, ready: false }, { status: 503 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "assistant failed" }, { status: 500 });
  }
}
