import { notFound } from 'next/navigation';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';
import { deploymentProfile } from '@/lib/deployment/profile';
import { resetAudienceFromParam } from '@/lib/auth/password-reset-policy';

/**
 * Choose a new password, from the link in the email.
 *
 * WHY THE SERVER NEVER SEES THE TOKEN
 * -----------------------------------
 * The link carries the token in its FRAGMENT — the part after the `#`. The
 * browser does not send a fragment to the server: not in the request, not in
 * a referrer, not in a log. So the token is read in the browser, and posted
 * in the body of the redemption, and the server only ever sees it in the
 * body of a POST.
 *
 * That is why this page reads NO token at all. A token the server can read is
 * a token that was in the query string, and a token in the query string goes
 * into the browser's history, into the address bar, into every log that
 * records the request line, and into the `Referer` of the next request the
 * page makes. It was good for half an hour, and anybody who could read any
 * of those could spend it.
 *
 * WHICH MEANS THE PAGE CANNOT CHECK THE LINK
 * --------------------------------------------
 * It could look the token up and say "this one is expired" before rendering.
 * It must not: an unknown token and an expired token are refused for the
 * SAME reason, and a page that told them apart would be a way to find out
 * which tokens exist. So the page renders either way, and the SERVER
 * decides — and a link with no token at all still renders a page rather than
 * an error: the honest answer is "that link is not valid, ask for a new one",
 * and it is the same answer an expired link gets.
 *
 * The AUDIENCE is still read here, from the query string. It is not a secret:
 * it chooses between three sign-in pages this application serves, and the
 * door is worked out by the ONE rule the email and the redemption use.
 */
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string }>;
}) {
  const profile = deploymentProfile();

  // Under the SaaS, Supabase Auth owns password recovery.
  if (profile.supabaseAuth) notFound();

  const sp = await searchParams;

  // The audience the link names, worked out by the ONE rule the email and
  // the redemption use. The page keeps no private copy of it — that is how
  // the three drifted apart in the first place.
  const audience = resetAudienceFromParam(sp.audience, profile.ownerPortal);

  return <ResetPasswordForm audience={audience} />;
}
