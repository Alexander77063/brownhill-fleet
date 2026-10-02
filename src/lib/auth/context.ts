/**
 * Tenant-aware auth context — the single place the app learns *who* the request
 * is and *which tenant* it's acting in. This is a portability seam: today it reads
 * the Supabase session and the user's memberships (RLS-scoped); if we later move to
 * a direct-Postgres deployment this is also where we'd `SET app.user_id` /
 * `SET app.tenant_id` on the connection. Everything downstream depends on this
 * shape, not on Supabase specifics.
 */

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { deploymentProfile } from "@/lib/deployment/profile";
import { effectivePermissions, type Permission } from "@/lib/iam";
import { readSessionToken, SESSION_COOKIE } from "./local-session";

/**
 * The signed-in user's id, from whichever identity system this build uses.
 *
 * Hosted: Supabase Auth's session. Standalone: our own HS256 cookie, verified
 * here with the same secret PostgREST verifies it with — so the app and the
 * database can never disagree about who is calling.
 */
export async function currentUserId(): Promise<string | null> {
  if (!deploymentProfile().supabaseAuth) {
    const jar = await cookies();
    const claims = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
    return claims?.sub ?? null;
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return user?.id ?? null;
}

export type MembershipStatus = "active" | "invited" | "disabled";

export interface TenantMembership {
  tenant_id: string;
  role: string;
  permissions: string[];
  status: MembershipStatus;
}

export interface AuthContext {
  userId: string;
  /** The active tenant for this request (null if the user belongs to none). */
  tenantId: string | null;
  role: string | null;
  permissions: string[];
  /** All tenants the user can act in (they may belong to several). */
  memberships: TenantMembership[];
}

/**
 * Resolve the signed-in user's tenant context, or null if unauthenticated. The
 * active tenant defaults to the first active membership; a later tenant-switcher
 * (cookie / header) will pin a specific one. RLS guarantees the user can only ever
 * read tenants they're a member of, so this can't be spoofed by the client.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const userId = await currentUserId();
  if (!userId) return null;

  const sb = await createClient();
  const { data } = await sb
    .from("tenant_memberships")
    .select("tenant_id, role, permissions, status")
    .eq("status", "active");

  const memberships = (data ?? []) as TenantMembership[];
  const active = memberships[0] ?? null;

  return {
    userId,
    tenantId: active?.tenant_id ?? null,
    role: active?.role ?? null,
    permissions: active?.permissions ?? [],
    memberships,
  };
}

/**
 * Require an authenticated user bound to a tenant. Throws if unauthenticated or
 * tenantless — used by server actions / routes that must act within a tenant.
 */
export async function requireTenantContext(): Promise<
  AuthContext & { tenantId: string }
> {
  const ctx = await getAuthContext();
  if (!ctx) throw new Error("Not authenticated");
  if (!ctx.tenantId) throw new Error("User is not a member of any tenant");
  return ctx as AuthContext & { tenantId: string };
}

/** True if the current active membership holds `perm` (role defaults + grants). */
export function contextCan(ctx: AuthContext, perm: Permission): boolean {
  return effectivePermissions(ctx.role ?? "", ctx.permissions).has(perm);
}

/**
 * Require an authenticated, tenant-bound user who holds `perm`. Throws otherwise.
 * Server actions and routes call this to enforce fine-grained authorization on
 * top of RLS.
 */
export async function requirePermission(
  perm: Permission,
): Promise<AuthContext & { tenantId: string }> {
  const ctx = await requireTenantContext();
  if (!contextCan(ctx, perm)) {
    throw new Error(`You don't have permission to do this (${perm}).`);
  }
  return ctx;
}

/**
 * True if the signed-in user is a PLATFORM super-admin — a higher authority than
 * any tenant role, who manages the global product catalogue (plans/add-ons/prices)
 * and cross-tenant platform tools. Backed by the `platform_admins` allow-list
 * (migration 0029); RLS hides that table from non-admins, so a null read == not an
 * admin. Distinct from tenant RBAC (`requirePermission`).
 */
export async function isPlatformAdmin(): Promise<boolean> {
  const userId = await currentUserId();
  if (!userId) return false;
  const sb = await createClient();
  const { data } = await sb
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Require a signed-in PLATFORM super-admin. Throws otherwise. Gates the platform
 * console (catalogue management + cross-tenant tools).
 */
export async function requirePlatformAdmin(): Promise<{ userId: string }> {
  const userId = await currentUserId();
  if (!userId) throw new Error("Not authenticated");
  const sb = await createClient();
  const { data } = await sb
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Platform admin access required.");
  return { userId };
}
