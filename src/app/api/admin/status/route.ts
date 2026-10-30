// src/app/api/admin/status/route.ts — owner-only status surface (Spec §3.7)
//
// The status surface reads the backups the customer's own box writes, so it
// exists only on a box the customer operates. It used to gate on
// `DEPLOYMENT_PROFILE === 'standalone'` — the desktop product — and answered
// 404 on the hosted deployment.
//
// It lives under /api/admin rather than beside the page at /admin/status
// because Next.js refuses to build a route handler and a page at the same
// path ("You cannot have two parallel pages that resolve to the same path").
// Every other route handler in this app is under /api for the same reason.
import { NextResponse, NextRequest } from 'next/server';
import { readSessionClaims } from '@/lib/auth/local-session';
import { deploymentProfile } from '@/lib/deployment/profile';
import { collectBoxStatus } from '@/lib/backup/status';

const CUSTOMER_OPS = deploymentProfile().customerOps;

export async function GET(_req: NextRequest) {
  if (!CUSTOMER_OPS) return new NextResponse('Not found', { status: 404 });
  const claims = await readSessionClaims();
  if (claims?.role !== 'owner') return new NextResponse('forbidden', { status: 403 });

  // The facts come from one collector, shared with the page, so the JSON an
  // operator curls and the page they read cannot disagree.
  return NextResponse.json(await collectBoxStatus());
}
