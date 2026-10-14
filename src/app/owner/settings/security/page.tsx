// src/app/owner/settings/security/page.tsx
import { PageHeader, Card, CardTitle } from '@/components/ui';
import { getSessionProfile } from '@/lib/auth';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';

export const dynamic = 'force-dynamic';

export default async function OwnerSecurityPage() {
  const me = await getSessionProfile();

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Account security"
        subtitle="The email and password you sign in with. Brownhill doesn't see your password; we only store a one-way hash."
      />

      <Card className="reveal mt-5 max-w-xl">
        <CardTitle>Account</CardTitle>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="eyebrow text-parchment">Sign-in email</dt>
            <dd className="mt-1 text-sm text-cream">{me?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="eyebrow text-parchment">Role</dt>
            <dd className="mt-1 text-sm text-cream">Vehicle owner</dd>
          </div>
        </dl>
      </Card>

      <Card className="reveal mt-5 max-w-xl">
        <CardTitle>Change password</CardTitle>
        <p className="mt-1 text-sm text-muted">
          12 characters or more.
        </p>
        <div className="mt-4">
          <ChangePasswordForm />
        </div>
      </Card>
    </>
  );
}
