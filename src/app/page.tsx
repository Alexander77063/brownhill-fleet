import { redirect } from 'next/navigation';
import { getSessionProfile } from '@/lib/auth';
import { deploymentProfile } from '@/lib/deployment/profile';
import { payFirst } from '@/lib/region';
import { Landing } from '@/components/marketing/Landing';
import { NigeriaLanding } from '@/components/marketing/NigeriaLanding';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const profile = await getSessionProfile();
  // Signed-in users go straight to their portal.
  if (profile) {
    redirect(profile.role === 'driver' ? '/driver' : profile.role === 'owner' ? '/owner' : '/ops');
  }

  // The landing page is a sales page: it pitches the platform, quotes pricing
  // and invites the reader to sign up. On a build the customer already owns
  // there is nothing to sell them, and showing it would put a marketing site
  // for a different product at the front door of their own system. They get the
  // sign-in page instead.
  // The landing page is the SaaS sales page. A build with no self-serve
  // signup has nothing to sell at its front door: visitors sign in instead.
  if (!deploymentProfile().selfServeSignup) {
    redirect('/login');
  }

  // The shared instance in a pay-first market sells protection to individuals:
  // live prices from the catalogue, sign-in by phone (NG-2).
  if (payFirst()) return <NigeriaLanding />;

  return <Landing />;
}
