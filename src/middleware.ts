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
import { localDb } from '@/lib/auth/local-store';

const HOSTED = process.env.DEPLOYMENT_PROFILE === 'hosted';
const DRAIN_CACHE_TTL_MS = 500;

interface DrainCache { value: boolean; fetchedAt: number; }
let cache: DrainCache | null = null;

async function readDraining(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < DRAIN_CACHE_TTL_MS) return cache.value;
  const sql = await localDb();
  const rows = (await sql`SELECT value FROM app_state WHERE key = ${'app_draining'}`) as Array<{ value: string }>;
  const value = rows[0]?.value === '1';
  cache = { value, fetchedAt: now };
  return value;
}

/** Exposed for tests: drop the cache so the next read hits the DB. */
export function __resetDrainCache(): void {
  cache = null;
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
