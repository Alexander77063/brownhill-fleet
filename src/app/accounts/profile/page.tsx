import { PageHeader, Card } from '@/components/ui';
import { getSessionProfile } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * The accountant's profile page — read-only for now (password change is at
 * /login or via the local change-password route once the user has a real
 * session). The nav entry is there so the role has a complete destination
 * like every other portal.
 */
export default async function AccountsProfilePage() {
  const p = await getSessionProfile();
  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="Profile"
        subtitle="Who you are, what role you hold, what permissions you've been granted."
      />
      <Card>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="eyebrow text-parchment">Name</dt>
            <dd className="mt-1 text-cream">{p?.fullName ?? '—'}</dd>
          </div>
          <div>
            <dt className="eyebrow text-parchment">Email</dt>
            <dd className="mt-1 text-cream">{p?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="eyebrow text-parchment">Role</dt>
            <dd className="mt-1 font-mono text-cream">{p?.role ?? '—'}</dd>
          </div>
          <div>
            <dt className="eyebrow text-parchment">Portal</dt>
            <dd className="mt-1 font-mono text-cream">/accounts</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}