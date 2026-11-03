/**
 * Which sign-in methods a build may offer, and which one it leads with.
 *
 * The sign-in page used to decide this by testing the profile id against the
 * literal `'standalone'`. The deployment Brownhill actually runs is `hosted` —
 * the same product on a server rather than a desktop — so it fell through to
 * the "this build has owners" branch and offered *Phone code* first, on a
 * build that has no vehicle owners at all. There was nobody for that method
 * to sign in: `resolveOwnerSignIn` refuses staff outright ("Staff accounts
 * sign in with a password") and refuses unknown numbers on a dedicated
 * instance. The operator's first screen on the live box asked for a mobile
 * number they do not have.
 *
 * The rule is not "what is this profile called" but "what can this build
 * actually do":
 *
 *   * a text-message code needs vehicle owners to receive it;
 *   * an email link needs Supabase Auth, which only the SaaS has;
 *   * a password works everywhere, so it is always offered.
 *
 * This module is deliberately pure — it takes a profile id and returns the
 * answer — so the rule can be unit-tested on its own, and so the client
 * bundle can read it without importing anything server-side.
 *
 * The profile id arrives from `NEXT_PUBLIC_DEPLOYMENT_PROFILE`, which
 * next.config derives from the same `DEPLOYMENT_PROFILE` the server reads,
 * so the bundle and the server always agree. An unrecognised value is read
 * as the SaaS, which is what `deploymentBrand()` already does with it.
 */

export type SignInMode = 'email' | 'phone' | 'password';

export interface SignInCapabilities {
  /** The methods this build may offer, in the order they appear. */
  readonly modes: readonly SignInMode[];
  /** The method the page starts on. */
  readonly defaultMode: SignInMode;
  /** This build has vehicle owners, who sign in with a code sent to their phone. */
  readonly ownerBuild: boolean;
  /** Identity comes from Supabase Auth, so this build can send a magic link. */
  readonly supabaseAuth: boolean;
  /**
   * This build's first-run path is the browser setup page.
   *
   * The desktop product and the dedicated Nigerian instance both create their
   * first account and tenant at `/setup`, and the sign-in page sends the
   * operator there when the database is empty. The hosted deployment does
   * not: it is onboarded through `/api/v1/bootstrap`, so its sign-in page
   * must not send anyone to `/setup` behind the operator's back.
   *
   * This is about which door the handover tells the operator to use, not
   * about which door is safe: both close the first-run window, in the same
   * transaction that creates the owner.
   */
  readonly setupPathBuild: boolean;
}

type Profile = 'saas' | 'standalone' | 'hosted' | 'managed' | 'managed-shared';

const PROFILES: readonly Profile[] = ['saas', 'standalone', 'hosted', 'managed', 'managed-shared'];

function normalise(raw: string | undefined | null): Profile {
  const value = (raw ?? '').trim().toLowerCase();
  return (PROFILES as readonly string[]).includes(value) ? (value as Profile) : 'saas';
}

export function signInCapabilities(raw: string | undefined | null): SignInCapabilities {
  const profile = normalise(raw);

  // The two builds with vehicle owners: the dedicated Nigerian instance and
  // the shared one. Both sign owners in with a code sent to their phone.
  const ownerBuild = profile === 'managed' || profile === 'managed-shared';

  // The SaaS has Supabase Auth, so it can send a magic link as well.
  const supabaseAuth = profile === 'saas';

  const modes: readonly SignInMode[] = supabaseAuth
    ? ['email', 'password', 'phone']
    : ownerBuild
      ? ['phone', 'password']
      : ['password'];

  const defaultMode: SignInMode = supabaseAuth ? 'email' : ownerBuild ? 'phone' : 'password';

  return {
    modes,
    defaultMode,
    ownerBuild,
    supabaseAuth,
    setupPathBuild: profile === 'standalone' || profile === 'managed',
  };
}
