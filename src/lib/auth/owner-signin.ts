/**
 * The one place a phone number becomes, or is matched to, an owner account.
 *
 * Pure over `store`, so every branch — first sign-in, repeat sign-in, the
 * hijack guard, an ambiguous number, self-serve on the shared instance, an
 * unknown number on a dedicated one, a staff member typing their phone — is
 * unit-tested without a database. See the NG-4 spec §4.3.
 */
export interface OwnerLite {
  id: string;
  tenantId: string;
  userId: string | null;
  name: string;
}

export interface OwnerStore {
  findOwnersByPhone(phone: string): Promise<OwnerLite[]>;
  profileForUser(userId: string): Promise<{ vehicleOwnerId: string | null; role: string } | null>;
  staffProfileByPhone(phone: string): Promise<{ id: string; role: string } | null>;
  createPhoneUser(phone: string, fullName?: string): Promise<{ id: string }>;
  link(
    ownerId: string,
    userId: string,
    tenantId: string,
    membershipRole: 'vehicle_owner' | 'owner',
  ): Promise<void>;
  createIndividualTenant(userId: string, phone: string): Promise<{ tenantId: string; ownerId: string }>;
}

export type SignInDecision =
  | { ok: true; userId: string; tenantId: string }
  | { ok: false; reason: 'ambiguous' | 'unknown' | 'hijack' | 'staff' };

export async function resolveOwnerSignIn(
  phone: string,
  caps: { singleTenant: boolean; selfServeSignup: boolean },
  store: OwnerStore,
): Promise<SignInDecision> {
  const owners = await store.findOwnersByPhone(phone);
  if (owners.length > 1) return { ok: false, reason: 'ambiguous' };

  if (owners.length === 1) {
    const owner = owners[0];
    if (owner.userId) {
      const prof = await store.profileForUser(owner.userId);
      // A number that changed hands is resolved by staff, never by sign-in.
      if (prof?.vehicleOwnerId && prof.vehicleOwnerId !== owner.id) return { ok: false, reason: 'hijack' };
      return { ok: true, userId: owner.userId, tenantId: owner.tenantId };
    }
    const user = await store.createPhoneUser(phone, owner.name);
    const prof = await store.profileForUser(user.id);
    if (prof?.vehicleOwnerId && prof.vehicleOwnerId !== owner.id) return { ok: false, reason: 'hijack' };
    await store.link(owner.id, user.id, owner.tenantId, 'vehicle_owner');
    return { ok: true, userId: user.id, tenantId: owner.tenantId };
  }

  const staff = await store.staffProfileByPhone(phone);
  if (staff) return { ok: false, reason: 'staff' };
  if (!caps.selfServeSignup) return { ok: false, reason: 'unknown' };

  // The shared instance: an unknown number is a new customer. They become a
  // tenant of their own, on the entry tier, with an owner record linked.
  const user = await store.createPhoneUser(phone);
  const { tenantId } = await store.createIndividualTenant(user.id, phone);
  return { ok: true, userId: user.id, tenantId };
}
