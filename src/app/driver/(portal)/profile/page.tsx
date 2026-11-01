// src/app/driver/profile/page.tsx
import { PageHeader, Card, CardTitle } from '@/components/ui';
import { getSessionProfile } from '@/lib/auth';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';

export const dynamic = 'force-dynamic';

export default async function DriverProfilePage() {
  const me = await getSessionProfile();

  return (
    <>
      <PageHeader
        eyebrow="You"
        title="Profile & security"
        subtitle="The email and password you sign in with. Your dispatcher can see your work, not your password."
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
            <dd className="mt-1 text-sm text-cream">Driver</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="eyebrow text-parchment">Display name</dt>
            <dd className="mt-1 text-sm text-cream">{me?.fullName ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      <Card className="reveal mt-5 max-w-xl">
        <CardTitle>Change password</CardTitle>
        <p className="mt-1 text-sm text-muted">
          12 characters or more. Keep it to yourself — your dispatcher will never ask.
        </p>
        <div className="mt-4">
          <ChangePasswordForm />
        </div>
      </Card>
    </>
  );
}
