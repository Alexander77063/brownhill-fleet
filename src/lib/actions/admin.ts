'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthContext, requirePermission } from '@/lib/auth/context';
import { createPortalSession, createSubscriptionCheckout, getTenantBilling, type Plan } from '@/lib/billing';
import { assertAssignableRole, isAssignableStatus } from '@/lib/iam';

async function baseUrl(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  const h = await headers();
  return `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host') ?? 'localhost:3000'}`;
}

const PAID_PLANS = new Set<Plan>(['starter', 'growth', 'scale']);
import {
  addMemberByEmail,
  createTenant,
  updateMember,
  updateTenantSettings,
  type TenantPatch,
} from '@/lib/tenancy';

const MODULE_KEYS = ['rental', 'compliance', 'bookings', 'gps'] as const;

/** Any signed-in user can create a tenant and become its owner (self-onboarding). */
export async function createTenantAction(formData: FormData): Promise<void> {
  const ctx = await getAuthContext();
  if (!ctx) throw new Error('Not authenticated');
  await createTenant(
    { name: String(formData.get('name') ?? ''), slug: String(formData.get('slug') ?? '') },
    ctx.userId,
  );
  revalidatePath('/admin');
}

export async function updateSettingsAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('tenant.settings');
  const modules: Record<string, boolean> = {};
  for (const k of MODULE_KEYS) modules[k] = formData.get(`module_${k}`) === 'on';
  // NOTE: plan is intentionally NOT settable here — it's driven by the canonical
  // tenant_subscription (Stripe checkout for tenants, platform console for the
  // operator). The old settings dropdown only wrote the display-only tenants.plan.
  const patch: TenantPatch = {
    name: String(formData.get('name') ?? '') || undefined,
    status: (String(formData.get('status') ?? '') || undefined) as TenantPatch['status'],
    modules,
  };
  await updateTenantSettings(ctx.tenantId, patch, ctx.userId);
  revalidatePath('/admin');
}

export async function addMemberAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('members.manage');
  const role = String(formData.get('role') ?? 'ops');
  assertAssignableRole(role, ctx.role); // validate + block owner/admin escalation
  await addMemberByEmail(ctx.tenantId, String(formData.get('email') ?? ''), role, ctx.userId);
  revalidatePath('/admin');
}

export async function updateMemberAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('members.manage');
  const roleRaw = String(formData.get('role') ?? '');
  const statusRaw = String(formData.get('status') ?? '');
  if (roleRaw) assertAssignableRole(roleRaw, ctx.role);
  if (statusRaw && !isAssignableStatus(statusRaw)) throw new Error(`Invalid status: ${statusRaw}`);
  await updateMember(
    ctx.tenantId,
    String(formData.get('user_id') ?? ''),
    {
      role: roleRaw || undefined,
      status: statusRaw ? (statusRaw as 'active' | 'disabled') : undefined,
    },
    ctx.userId,
  );
  revalidatePath('/admin');
}

/** Start a Stripe Checkout to move the tenant onto a paid plan. */
export async function startCheckoutAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission('subscription.manage');
  const plan = String(formData.get('plan') ?? '') as Plan;
  if (!PAID_PLANS.has(plan)) throw new Error('Invalid plan');
  const origin = await baseUrl();
  const billing = await getTenantBilling(ctx.tenantId);
  const { url } = await createSubscriptionCheckout({
    tenantId: ctx.tenantId,
    plan,
    successUrl: `${origin}/admin?billing=success`,
    cancelUrl: `${origin}/admin`,
    customerId: billing?.stripe_customer_id ?? undefined,
  });
  redirect(url);
}

/** Open the Stripe billing portal for the tenant's existing customer. */
export async function openPortalAction(): Promise<void> {
  const ctx = await requirePermission('subscription.manage');
  const billing = await getTenantBilling(ctx.tenantId);
  if (!billing?.stripe_customer_id) throw new Error('No billing account yet — start a subscription first.');
  const { url } = await createPortalSession(billing.stripe_customer_id, `${await baseUrl()}/admin`);
  redirect(url);
}
