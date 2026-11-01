'use server';

/**
 * The operator's password reset.
 *
 * Until this existed, a forgotten password could only be recovered by SSHing
 * into the customer's own box and running `set-customer-password.mjs` against
 * the database. The two portal sign-in pages both carried a "Forgot password?"
 * link that pointed at a page behind their own layout, so a locked-out user
 * was bounced back to the sign-in form in a loop.
 *
 * This action is the door that works: the dispatcher (or the business owner)
 * opens the member's record, presses one button, and gets a temporary
 * password to read out. The decision half — who may reset whom, what happens
 * when the email fails — lives in `src/lib/auth/password-reset.ts`, which is
 * unit-tested without a database.
 *
 * Two things this action deliberately does NOT do:
 *
 *   * It does not accept a password from the caller. The temporary password is
 *     generated here, from the system CSPRNG, so no password ever travels
 *     through the browser as form data.
 *   * It does not let an operator reset a member they could not have given
 *     that role to. Resetting somebody's password is signing in as them, and
 *     that guard is `assertCanResetPassword`.
 */

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { deploymentProfile } from '@/lib/deployment/profile';
import { localHasPassword, setLocalPassword } from '@/lib/auth/local-store';
import {
  resetMemberPassword,
  type PasswordResetStore,
  type ResetMember,
} from '@/lib/auth/password-reset';
import { recordAudit } from '@/lib/audit';
import { createServiceClient } from '@/lib/supabase/server';
import { getBranding, brandDisplayName, brandEmailFrom } from '@/lib/branding';
import { sendTenantEmail } from '@/lib/email/tenant-email';
import { sendEmail } from '@/lib/notify';

export interface ResetPasswordResult {
  ok: boolean;
  /** The temporary password. Shown once, so the operator can hand it over. */
  temporaryPassword?: string;
  /** True when it was also emailed to the member. */
  emailed?: boolean;
  /** Typed error code, for the panel to branch on. */
  error?: 'not_found' | 'no_password' | 'forbidden' | 'failed' | 'unsupported';
  /** Human-readable text. */
  message?: string;
}

/** Where a person of this role signs in, and where they change their password. */
const SIGN_IN_PATH: Record<string, string> = {
  driver: '/driver/login',
};

const SETTINGS_PATH: Record<string, string> = {
  driver: '/driver/profile',
  vehicle_owner: '/owner/settings/security',
  accounts: '/accounts/profile',
};

/** The absolute origin of this deployment, for the links in the email. */
async function baseUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  if (configured) return configured;
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

/**
 * The real store: the membership lookup is tenant-scoped, and the password
 * write goes through the direct connection that owns `auth.local_credentials`.
 */
function makeStore(tenantId: string): PasswordResetStore {
  return {
    async findMember(scopeTenantId, userId) {
      const sb = createServiceClient();
      // The tenant filter is what makes this safe: a user id from another
      // tenant simply is not a member here, and nothing is reset.
      const { data: membership } = await sb
        .from('tenant_memberships')
        .select('user_id, role, status')
        .eq('tenant_id', scopeTenantId)
        .eq('user_id', userId)
        .maybeSingle();
      if (!membership) return null;

      const { data: profile } = await sb
        .from('profiles')
        .select('full_name, email')
        .eq('id', userId)
        .maybeSingle();

      const m = membership as { user_id: string; role: string; status: string };
      const p = profile as { full_name: string | null; email: string | null } | null;
      return {
        userId: m.user_id,
        role: m.role,
        status: m.status,
        fullName: p?.full_name ?? null,
        email: p?.email ?? null,
      } satisfies ResetMember;
    },

    async hasPassword(userId) {
      return localHasPassword(userId);
    },

    async findMemberships(userId) {
      // Every tenant this person belongs to, not just this one.
      //
      // The password row is keyed by user id, so the credential is shared
      // across every tenant they hold. The guard needs the whole list to
      // know whether the caller has authority everywhere the reset lands.
      const sb = createServiceClient();
      const { data } = await sb
        .from('tenant_memberships')
        .select('tenant_id, role, status')
        .eq('user_id', userId);
      const rows = (data ?? []) as Array<{
        tenant_id: string;
        role: string;
        status: string;
      }>;
      return rows.map((m) => ({
        tenantId: m.tenant_id,
        role: m.role,
        status: m.status,
      }));
    },

    async setPassword(userId, password) {
      // setLocalPassword also clears `failed_attempts` and `locked_until`, so a
      // reset un-locks an account that was locked out for too many attempts.
      await setLocalPassword(userId, password);
    },

    async deliverTemporaryPassword(member, password) {
      if (!member.email) return { sent: false, reason: 'no email address on file' };

      const branding = await getBranding(tenantId);
      const brand = brandDisplayName(branding);
      const base = await baseUrl();
      const signInUrl = `${base}${SIGN_IN_PATH[member.role] ?? '/login'}`;
      const settingsUrl = `${base}${SETTINGS_PATH[member.role] ?? '/ops/profile'}`;
      const who = member.fullName || member.email;

      const subject = `Your ${brand} password has been reset`;
      const html =
        `<p>Hi ${escapeHtml(who)},</p>` +
        `<p>${escapeHtml(brand)} has reset the password on your account.</p>` +
        `<p>Your temporary password is <code>${escapeHtml(password)}</code></p>` +
        `<p>Sign in at <a href="${signInUrl}">${signInUrl}</a> and change it straight away ` +
        `from <a href="${settingsUrl}">your profile page</a>.</p>` +
        `<p>If you did not expect this, tell the operator who reset it.</p>`;

      // The tenant's own email first, then the platform's — the same order the
      // driver invite uses, so onboarding and recovery behave identically.
      let res = await sendTenantEmail(tenantId, member.email, subject, html);
      if (res.skipped) {
        const platformFrom =
          process.env.NOTIFY_FROM_EMAIL || 'Elite Fleet Management <fleet@elitefleetmanagement.co.uk>';
        res = await sendEmail(member.email, subject, html, brandEmailFrom(branding, platformFrom));
      }
      return { sent: res.sent, reason: res.skipped ? 'email is not configured' : res.error };
    },
  };
}

/** Escape a value before it goes into an email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Reset a member's password and hand the temporary password back to the
 * operator.
 *
 * The password is returned rather than only emailed, because a self-hosted
 * install frequently has no email provider configured — in which case the
 * operator reading it out over the telephone is the whole recovery path.
 */
export async function resetMemberPasswordAction(
  formData: FormData,
): Promise<ResetPasswordResult> {
  const ctx = await getAuthContext();
  if (!ctx || !ctx.tenantId || !contextCan(ctx, 'members.manage')) {
    return {
      ok: false,
      error: 'forbidden',
      message: 'You do not have permission to reset passwords on this account.',
    };
  }

  const userId = String(formData.get('user_id') ?? '').trim();
  if (!userId) {
    return { ok: false, error: 'not_found', message: 'No account was selected.' };
  }

  if (deploymentProfile().supabaseAuth) {
    // On the SaaS, identity is Supabase Auth's; it owns password resets, and
    // this build has no local credential row to write.
    return {
      ok: false,
      error: 'unsupported',
      message:
        'This deployment signs in through the account provider, which handles password resets itself.',
    };
  }

  // The caller's role in every tenant they belong to.
  //
  // The reset writes one credential for the user, and that credential opens
  // their accounts in every tenant they hold. So the authority to reset has
  // to exist in each of them, not only in the one being viewed. `ctx.memberships`
  // is already filtered to active memberships, which is exactly the set that
  // can grant authority.
  const callerRoles: Record<string, string> = {};
  for (const m of ctx.memberships) {
    if (m.tenant_id && m.role) callerRoles[m.tenant_id] = m.role;
  }

  const outcome = await resetMemberPassword({
    tenantId: ctx.tenantId,
    userId,
    callerRole: ctx.role,
    callerRoles,
    store: makeStore(ctx.tenantId),
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.reason, message: outcome.message };
  }

  await recordAudit({
    action: 'member.password_reset',
    entityType: 'member',
    entityId: userId,
    detail: { role: outcome.member.role, emailed: outcome.emailed },
  });

  revalidatePath('/admin/members');
  revalidatePath('/ops/drivers');

  return {
    ok: true,
    temporaryPassword: outcome.temporaryPassword,
    emailed: outcome.emailed,
  };
}
