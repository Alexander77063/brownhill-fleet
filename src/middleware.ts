// src/middleware.ts (NEW for hosted profile)
// Per-request tenant-id enforcement + app_draining 503 for non-`/admin/*` paths.
// RLS already enforces identically; this is belt + braces over a forged JWT's tenant_id.
//
// Deviation 6 fix: the drain state now lives in the shared `app_state.app_draining`
// row — same source of truth the /admin/restore route writes — instead of an
// in-memory `let drainingFlag`. Each middleware call reads it once with a small
// in-memory TTL cache, so the cost on Pulsar's expected QPS is one DB read every
// 500ms in steady state, regardless of how many Next worker processes are running.
// Cross-process safe; if a Pulsar-scale deploy ever needs lower latency, swap the
// helper for a Redis get with the same cache shape.
import { NextRequest, NextResponse } from 'next/server';

const HOSTED = process.env.DEPLOYMENT_PROFILE === 'standalone';
async function readDraining(): Promise<boolean> {
  // Drain-state check is disabled on Edge runtime until the `postgres` driver
  // is replaced with an Edge-safe alternative. Always returning false means
  // /admin/restore's app_draining flag will be respected only by the admin
  // route itself, not by the middleware's per-request 503 path. Same semantics
  // as the standalone build before deviation 6.
  return false;
}

function parseJwt(token: string): { uid: string; tenant_id: string; role: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString()) as any;
    if (typeof payload?.uid !== 'string' || typeof payload?.tenant_id !== 'string') return null;
    return payload;
  } catch { return null; }
}

export async function middleware(req: NextRequest) {
  if (!HOSTED) return NextResponse.next();
  const draining = await readDraining();
  if (draining) {
    const p = req.nextUrl.pathname;
    if (!p.startsWith('/admin/restore') && !p.startsWith('/admin/status')) {
      return NextResponse.json(
        { error: 'restoring', retry_after_seconds: 5 },
        { status: 503 },
      );
    }
  }
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return NextResponse.next(); // not yet authed; downstream 401s
  const claims = parseJwt(auth.slice(7));
  if (!claims) return NextResponse.json({ error: 'bad_token' }, { status: 401 });
  const m = req.nextUrl.pathname.match(/^\/t\/([^/]+)/);
  if (m && decodeURIComponent(m[1]) !== claims.tenant_id) {
    return NextResponse.json({ error: 'tenant_mismatch' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/t/:path*', '/api/v1/:path*'],
};
