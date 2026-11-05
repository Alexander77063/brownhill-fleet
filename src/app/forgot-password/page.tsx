import { notFound } from 'next/navigation';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';
import { deploymentProfile } from '@/lib/deployment/profile';
import { resetAudienceFromParam } from '@/lib/auth/password-reset-policy';

/**
 * Ask for a password reset link.
 *
 * WHY THIS IS A PAGE AND NOT A DIALOGUE
 * -------------------------------------
 * The person who needs it has, by definition, lost the thing that would let
 * them sign in. A route inside the portal layout would be behind the very
 * session they do not have — which is how the old "Forgot password?" links
 * became an infinite loop: the page bounced them straight back to the form
 * they came from.
 *
 * WHY IT IS RENDERED PER REQUEST
 * ------------------------------
 * Whether this deployment serves the page at all depends on the profile, and
 * the profile is read from the environment at run time. A page baked into the
 * build would decide that at build time, on a box whose `DEPLOYMENT_PROFILE`
 * was not set when the image was built — and would serve a 404 to a customer
 * who has paid for it.
 */
export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string }>;
}) {
  const profile = deploymentProfile();

  // Under the SaaS, Supabase Auth owns password recovery. This product must
  // not grow a second one that skips it.
  if (profile.supabaseAuth) notFound();

  const sp = await searchParams;

  // The audience says whose sign-in page this person ends at. It is only ever
  // a hint about the COPY — the link in the email carries the audience the
  // ACCOUNT'S OWN ROLE decides, which is the one that matters.
  //
  // And it is worked out by the ONE rule the email and the redemption use.
  // The page kept a private copy of it, which is how the three drifted apart
  // in the first place: the copy here did not know that the owner door only
  // exists on a build that has one.
  const audience = resetAudienceFromParam(sp.audience, profile.ownerPortal);

  return <ForgotPasswordForm audience={audience} />;
}
