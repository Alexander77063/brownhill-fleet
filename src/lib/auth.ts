import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { currentUserId } from '@/lib/auth/context';
import { ROLE_HOME } from '@/components/shell/nav';
import type { UserRole } from '@/lib/supabase/database.types';

export interface SessionProfile {
  userId: string;
  email: string | null;
  role: UserRole;
  fullName: string | null;
  driverId: string | null;
  vehicleOwnerId: string | null;
}

/**
 * Resolve the current user + profile, or null if signed out.
 *
 * Identity comes from `currentUserId`, not `supabase.auth.getUser()`, because
 * this must work in both products: a standalone install has no Supabase Auth at
 * all, so `getUser()` returns null there and every portal page would bounce the
 * signed-in owner straight back to /login.
 *
 * This is a second entry point alongside `getAuthContext` — that one resolves
 * the tenant and permissions, this one the portal role. Both now read the same
 * identity, which is the point: two auth paths that can disagree about who is
 * calling is exactly how a user ends up in the wrong portal.
 */
export async function getSessionProfile(): Promise<SessionProfile | null> {
  const userId = await currentUserId();
  if (!userId) return null;

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name, driver_id, vehicle_owner_id, email')
    .eq('id', userId)
    .single();

  return {
    userId,
    email: profile?.email ?? null,
    role: (profile?.role ?? 'driver') as UserRole,
    fullName: profile?.full_name ?? null,
    driverId: profile?.driver_id ?? null,
    vehicleOwnerId: profile?.vehicle_owner_id ?? null,
  };
}

/** Require a session with one of the allowed roles, else redirect. */
export async function requireRole(allowed: UserRole[]): Promise<SessionProfile> {
  const profile = await getSessionProfile();
  if (!profile) redirect('/login');
  if (!allowed.includes(profile.role)) {
    redirect(ROLE_HOME[profile.role]);
  }
  return profile;
}
