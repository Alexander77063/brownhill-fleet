// src/app/ops/profile/page.tsx
//
// Operator's profile / security page. Renders the user's current account
// info (read-only — email and role come from the JWT/profile, not editable
// here) and the change-password form. Email change is a separate flow
// because it requires confirmation against the new address; that's not in
// scope for this round.

import { PageHeader, Card, CardTitle } from '@/components/ui';
import { getSessionProfile } from '@/lib/auth';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';

export const dynamic = 'force-dynamic';

export default async function OpsProfilePage() {
  // The ops/layout already called requireRole(['ops']) — by the time this
  // page renders, the session is valid and the role is 'ops'.
  const me = await getSessionProfile();

  return (
    <>
      <PageHeader
        eyebrow="You"
        title="Profile & security"
        subtitle="Your sign-in details and the password you use to access Brownhill Fleet."
      />

      <Card className="reveal mt-5 max-w-2xl">
        <CardTitle>Account</CardTitle>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="eyebrow text-parchment">Sign-in email</dt>
            <dd className="mt-1 text-sm text-cream">{me?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="eyebrow text-parchment">Role</dt>
            <dd className="mt-1 text-sm text-cream">Operator (Fleet)</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="eyebrow text-parchment">Display name</dt>
            <dd className="mt-1 text-sm text-cream">{me?.fullName ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      <Card className="reveal mt-5 max-w-2xl">
        <CardTitle>Change password</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Pick something at least 12 characters long. We sign you out elsewhere automatically on next sign-in.
        </p>
        <div className="mt-4">
          <ChangePasswordForm />
        </div>
      </Card>
    </>
  );
}
