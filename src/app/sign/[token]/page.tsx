import { getSessionByToken } from '@/lib/signing';
import { operatorName } from '@/lib/branding';
import { deploymentBrand } from '@/lib/deployment/brand';
import { SignClient, type SessionView } from './SignClient';

// Public, unauthenticated page — the token in the URL is the authorisation.
export const dynamic = 'force-dynamic';

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await getSessionByToken(token);

  if (!resolved) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        style={{
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          background: '#0f1a2e',
          color: '#e7ecf3',
          fontFamily: 'system-ui, sans-serif',
          padding: 24,
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h1 style={{ fontSize: 22, marginBottom: 8, color: '#e9c96a' }}>Link not found</h1>
          {/* No valid token means no tenant to name, so this is the one place
              here that falls back to the product's own name. */}
          <p style={{ color: '#9fb0c4' }}>
            This signing link is invalid or has expired. Please ask{' '}
            {deploymentBrand().productName} for a fresh link.
          </p>
        </div>
      </main>
    );
  }

  // The signer is contracting with the operator, so every mention of "us" on
  // the signing pages must be the operator's name — resolved from the tenant on
  // the session, since this page has no signed-in user to infer it from.
  const session = resolved.session as unknown as SessionView & { tenant_id?: string };
  const operator = await operatorName(session.tenant_id);

  return (
    <SignClient
      token={token}
      role={resolved.role}
      session={session}
      operator={operator}
    />
  );
}
