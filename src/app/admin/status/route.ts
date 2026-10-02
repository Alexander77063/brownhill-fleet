// src/app/admin/status/route.ts — owner-only status surface (Spec §3.7)
import { NextResponse, NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'node:fs';
import { getClaims } from '@/lib/auth/local-store';
import { getAppState } from '@/lib/app-state';
import { localDb } from '@/lib/auth/local-store';

const HOSTED = process.env.DEPLOYMENT_PROFILE === 'hosted';
const INDEX_PATH = '/var/backups/brownhill/_index.json';

interface BackupMeta { ts: string; size: number; }

function readIndex(): BackupMeta[] {
  try {
    if (!existsSync(INDEX_PATH)) return [];
    return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch { return []; }
}

export async function GET(_req: NextRequest) {
  if (!HOSTED) return new NextResponse('Not found', { status: 404 });
  const claims = await getClaims();
  if (claims?.role !== 'owner') return new NextResponse('forbidden', { status: 403 });

  const sql = await localDb();
  const restoring = (await getAppState(sql, 'app_draining')) === '1';
  const bks = readIndex();
  const lastBackupAge = bks.length
    ? Math.max(0, Math.floor((Date.now() - new Date(bks[bks.length - 1].ts).getTime()) / 1000))
    : null;
  const uptimeS = Math.floor(process.uptime());
  const alerts: string[] = [];
  if (lastBackupAge != null && lastBackupAge > 26 * 3600) alerts.push('backup_stale');
  if (restoring) alerts.push('restoring');

  return NextResponse.json({ uptime: uptimeS, lastBackupAge, restoring, alerts });
}
