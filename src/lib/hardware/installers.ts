/**
 * Installers — our own fitters and the partner workshops we pay per job. The
 * fee schedule lives on the row (console-managed, minor units); a job snapshots
 * the fee when it is scheduled so a later price change never rewrites history.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { JOB_KINDS, type JobKind } from './derive';

type Sb = ReturnType<typeof createServiceClient>;

export interface Installer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  city: string | null;
  kind: 'own' | 'partner';
  fees: Partial<Record<JobKind, number>>;
  active: boolean;
  notes: string | null;
}

export interface InstallerInput {
  id?: string;
  name: string;
  phone: string;
  email?: string | null;
  city?: string | null;
  kind: 'own' | 'partner';
  fees: Partial<Record<JobKind, number>>;
  active?: boolean;
  notes?: string | null;
}

function toInstaller(r: Record<string, unknown>): Installer {
  const raw = (r.fees as Record<string, unknown>) ?? {};
  const fees: Partial<Record<JobKind, number>> = {};
  for (const k of JOB_KINDS) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) fees[k] = Math.round(v);
  }
  return {
    id: r.id as string,
    name: r.name as string,
    phone: r.phone as string,
    email: (r.email as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    kind: r.kind === 'own' ? 'own' : 'partner',
    fees,
    active: Boolean(r.active),
    notes: (r.notes as string | null) ?? null,
  };
}

export async function listInstallers(opts: { activeOnly?: boolean } = {}, sb: Sb = createServiceClient()): Promise<Installer[]> {
  let q = sb.from('installers').select('*').order('name');
  if (opts.activeOnly) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(toInstaller);
}

export async function installerById(id: string, sb: Sb = createServiceClient()): Promise<Installer | null> {
  const { data } = await sb.from('installers').select('*').eq('id', id).maybeSingle();
  return data ? toInstaller(data as Record<string, unknown>) : null;
}

/** Create or update. Fees are validated to non-negative integers per job kind. */
export async function saveInstaller(input: InstallerInput, sb: Sb = createServiceClient()): Promise<{ id: string }> {
  const name = input.name.trim();
  const phone = input.phone.trim();
  if (!name) throw new Error('An installer needs a name.');
  if (!phone) throw new Error('An installer needs a phone number — jobs are sent by SMS.');
  const fees: Record<string, number> = {};
  for (const k of JOB_KINDS) {
    const v = input.fees[k];
    if (v === undefined || v === null) continue;
    if (!Number.isFinite(v) || v < 0) throw new Error(`The ${k} fee must be zero or more.`);
    fees[k] = Math.round(v);
  }
  const row = {
    name,
    phone,
    email: input.email?.trim() || null,
    city: input.city?.trim() || null,
    kind: input.kind === 'own' ? 'own' : 'partner',
    fees: fees as never,
    active: input.active ?? true,
    notes: input.notes?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (input.id) {
    const { error } = await sb.from('installers').update(row as never).eq('id', input.id);
    if (error) throw new Error(error.message);
    return { id: input.id };
  }
  const { data, error } = await sb.from('installers').insert(row as never).select('id').single();
  if (error) throw new Error(error.message);
  return { id: (data as { id: string }).id };
}

/** The fee we pay this installer for a job of this kind, or null when none is set. */
export function feeFor(installer: Pick<Installer, 'fees'>, kind: JobKind): number | null {
  const v = installer.fees[kind];
  return typeof v === 'number' ? v : null;
}
