import { type NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/context";
import { askCopilot } from "@/lib/platform/copilot";
import { AiNotConfiguredError, type AiMessage } from "@/lib/ai";

// Platform copilot endpoint. Gated to platform admins (the layout only gates
// pages, not routes). Grounds Claude in the live platform snapshot and returns
// its answer, or a 503 with a friendly flag when AI is dormant (no key set).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
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
    const answer = await askCopilot(question, history);
    return NextResponse.json({ answer });
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return NextResponse.json({ error: err.message, configured: false }, { status: 503 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "copilot failed" }, { status: 500 });
  }
}
