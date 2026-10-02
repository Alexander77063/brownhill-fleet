/**
 * The real OwnerStore: the service client for everything in the public schema
 * (so the tenant-creation and membership paths are the same ones the console
 * uses), and the direct connection only for `auth.users`.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { createTenant } from '@/lib/tenancy';
import { createLocalPhoneUser } from './local-store';
import type { OwnerStore } from './owner-signin';

export const pgOwnerStore: OwnerStore = {
  async findOwnersByPhone(phone) {
    const sb = createServiceClient();
    const { data } = await sb.from('vehicle_owners').select('id, tenant_id, user_id, name').eq('phone', phone);
    return (data ?? []).map((o) => ({ id: o.id, tenantId: o.tenant_id, userId: o.user_id, name: o.name }));
  },

  async profileForUser(userId) {
    const sb = createServiceClient();
    const { data } = await sb.from('profiles').select('vehicle_owner_id, role').eq('id', userId).maybeSingle();
    return data ? { vehicleOwnerId: data.vehicle_owner_id, role: data.role } : null;
  },

  async staffProfileByPhone(phone) {
    const sb = createServiceClient();
    const { data } = await sb
      .from('profiles')
      .select('id, role')
      .eq('phone', phone)
      .neq('role', 'owner')
      .limit(1)
      .maybeSingle();
    return data ? { id: data.id, role: data.role } : null;
  },

  async createPhoneUser(phone, fullName) {
    return createLocalPhoneUser(phone, { role: 'owner', fullName });
  },

  async link(ownerId, userId, tenantId, membershipRole) {
    const sb = createServiceClient();
    const [{ data: prof }, { data: owner }] = await Promise.all([
      sb.from('profiles').select('vehicle_owner_id').eq('id', userId).maybeSingle(),
      sb.from('vehicle_owners').select('user_id').eq('id', ownerId).maybeSingle(),
    ]);
    // The hijack guard, enforced at the write as well as in the decision.
    if (prof?.vehicle_owner_id && prof.vehicle_owner_id !== ownerId) {
      throw new Error('account already linked to another owner');
    }
    if (owner?.user_id && owner.user_id !== userId) {
      throw new Error('owner already linked to another account');
    }
    const p = await sb.from('profiles').update({ vehicle_owner_id: ownerId, role: 'owner' } as never).eq('id', userId);
    if (p.error) throw new Error(p.error.message);
    const o = await sb.from('vehicle_owners').update({ user_id: userId } as never).eq('id', ownerId);
    if (o.error) throw new Error(o.error.message);
    const m = await sb
      .from('tenant_memberships')
      .upsert(
        { tenant_id: tenantId, user_id: userId, role: membershipRole, status: 'active' } as never,
        { onConflict: 'tenant_id,user_id' },
      );
    if (m.error) throw new Error(m.error.message);
  },

  async createIndividualTenant(userId, phone) {
    const short = userId.replace(/-/g, '').slice(0, 8);
    // createTenant makes them the tenant's owner and puts them on the region's
    // default plan (ng_standard_month), exactly as NG-1 built it.
    const { id: tenantId } = await createTenant({ name: `Owner ${phone.slice(-4)}`, slug: `owner-${short}` }, userId);
    const sb = createServiceClient();
    const { data, error } = await sb
      .from('vehicle_owners')
      .insert({ tenant_id: tenantId, user_id: userId, name: '', phone } as never)
      .select('id')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'could not create owner');
    const p = await sb.from('profiles').update({ vehicle_owner_id: data.id, role: 'owner' } as never).eq('id', userId);
    if (p.error) throw new Error(p.error.message);
    return { tenantId, ownerId: data.id };
  },
};
