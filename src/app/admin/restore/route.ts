// src/app/admin/restore/route.ts — owner-only restore-from-UI
// Listed in /admin/restore (GET) and triggered (POST) with a typed "RESTORE" confirmation.
// Drains the app via app_state.app_draining='1' for the duration of restore.sh.
import { NextRequest, NextResponse } from 'next/server';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { getClaims } from '@/lib/auth/local-store';   // session-cookie auth in the codebase
import { getAppState, setAppState } from '@/lib/app-state';
import { localDb } from '@/lib/auth/local-store';

const HOSTED = process.env.DEPLOYMENT_PROFILE === 'hosted';
const INDEX_PATH = '/var/backups/brownhill/_index.json';

export async function GET(_req: NextRequest) {
  if (!HOSTED) return new NextResponse('Not found', { status: 404 });
  const claims = await getClaims();
  if (claims?.role !== 'owner') return new NextResponse('forbidden', { status: 403 });
  if (!existsSync(INDEX_PATH)) return NextResponse.json({ backups: [] });
  return NextResponse.json(JSON.parse(readFileSync(INDEX_PATH, 'utf8')));
}

export async function POST(req: NextRequest) {
  if (!HOSTED) return new NextResponse('Not found', { status: 404 });
  const claims = await getClaims();
  if (claims?.role !== 'owner') return new NextResponse('forbidden', { status: 403 });
  const { backupId, confirmation } = (await req.json()) as { backupId?: string; confirmation?: string };
  if (confirmation !== 'RESTORE') {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }
  if (!backupId) {
    return NextResponse.json({ error: 'backupId_required' }, { status: 400 });
  }

  const sql = await localDb();
  await setAppState(sql, 'app_draining', '1');

  const r = spawnSync('/usr/local/bin/restore.sh', [backupId], { stdio: 'inherit' });
  const exitCode = r.status ?? 1;
  if (exitCode === 0) {
    await setAppState(sql, 'app_draining', '0');
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(
    { ok: false, error: 'restore_failed', drain: 'kept' },
    { status: 500 },
  );
}
