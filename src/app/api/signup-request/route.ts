import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// PUBLIC (unauthenticated) endpoint — a prospective tenant submits an access
// request. It writes via the SERVICE role (RLS forbids anon access to the table
// entirely), so a submitter can never read requests back. A honeypot field traps
// bots. This is intentionally the ONLY way rows enter tenant_signup_requests.
export const runtime = "nodejs";

const isEmail = (v: string) => v.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const cap = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // Honeypot: a real user never fills this hidden field. Pretend success.
  if (String(body.website ?? "").trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  // Cap every field — this is an unauthenticated write, so bound the row size.
  const company = cap(body.company, 200);
  const email = cap(body.email, 254).toLowerCase();
  if (!company || !isEmail(email)) {
    return NextResponse.json({ error: "A company name and a valid email are required." }, { status: 400 });
  }

  const sb = createServiceClient();
  const { error } = await sb.from("tenant_signup_requests").insert({
    company,
    email,
    contact_name: cap(body.contact_name, 200) || null,
    phone: cap(body.phone, 40) || null,
    fleet_size: cap(body.fleet_size, 40) || null,
    message: cap(body.message, 2000) || null,
    // The Terms/Privacy version the applicant agreed to (checkbox on the form).
    terms_version: cap(body.terms_version, 40) || null,
  });
  if (error) {
    return NextResponse.json({ error: "Could not submit your request. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
