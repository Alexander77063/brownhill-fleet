// src/app/sign/[token]/handover/page.tsx
// Public page (no login needed). The same signing token that authorises
// the partner / driver flow authorises this one. The driver (or partner)
// photographs the vehicle before / after handover so ops has a baseline
// when a damage report comes in.

import { localDb } from '@/lib/auth/local-store';
import { operatorName } from '@/lib/branding';
import { HandoverPhotoForm } from './HandoverPhotoForm';
import { HANDOVER_PHOTO_KINDS, HANDOVER_PHOTO_LABELS, MIN_HANDOVER_PHOTOS, isValidHandoverPhotoKind } from '@/lib/sign/handover-photo';

export const dynamic = 'force-dynamic';

interface SessionCheck {
  id: string;
  agreement_id: string | null;
  tenant_id: string;
  status: string;
}

interface UploadedPhoto {
  kind: string;
  uploadedAt: string;
}

async function loadSession(token: string): Promise<SessionCheck | null> {
  const sql = await localDb();
  const rows = (await sql`
    select id, agreement_id, tenant_id, status
      from signing_sessions
     where partner_token = ${token} or driver_token = ${token}
     limit 1
  `) as SessionCheck[];
  return rows[0] ?? null;
}

async function loadExistingPhotos(agreementId: string): Promise<UploadedPhoto[]> {
  const sql = await localDb();
  const rows = (await sql`
    select kind, uploaded_at
      from agreement_handover_photos
     where agreement_id = ${agreementId}::uuid
     order by uploaded_at asc
  `) as Array<{ kind: string; uploaded_at: string }>;
  return rows.map((r) => ({ kind: r.kind, uploadedAt: r.uploaded_at }));
}

export default async function HandoverPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await loadSession(token);

  if (!session) {
    return <Notice kind="error" title="Link not found" body="This signing link is invalid or has expired." />;
  }
  if (!session.agreement_id) {
    return <Notice kind="error" title="No agreement" body="This signing session isn't attached to an agreement." />;
  }
  if (session.status !== 'driver_sign' && session.status !== 'signed') {
    return (
      <Notice
        kind="error"
        title="Sign first, then photograph"
        body="Handover photos can only be uploaded once both parties have signed the agreement."
      />
    );
  }

  const operator = await operatorName(session.tenant_id);
  const existing = await loadExistingPhotos(session.agreement_id);
  const presentKinds = existing.filter((p) => isValidHandoverPhotoKind(p.kind)).map((p) => p.kind);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        minHeight: '100dvh',
        background: '#0f1a2e',
        color: '#e7ecf3',
        fontFamily: 'system-ui, sans-serif',
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <p style={{ fontSize: 12, color: '#9fb0c4', letterSpacing: 1, textTransform: 'uppercase' }}>
          {operator}
        </p>
        <h1 style={{ fontSize: 28, color: '#e9c96a', marginBottom: 8, marginTop: 4 }}>
          Vehicle handover photos
        </h1>
        <p style={{ color: '#9fb0c4', marginBottom: 24 }}>
          Take a photo of each side of the car. {MIN_HANDOVER_PHOTOS} photos is the minimum for a complete walkaround;
          more is better. These become the baseline the office compares future damage reports to.
        </p>

        {existing.length > 0 && (
          <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: 'rgba(184,151,42,0.08)', border: '1px solid rgba(184,151,42,0.3)' }}>
            <p style={{ margin: 0, fontSize: 14 }}>
              <strong>{existing.length}</strong> photo{existing.length === 1 ? '' : 's'} recorded so far:
              {' '}{existing.map((p) => HANDOVER_PHOTO_LABELS[isValidHandoverPhotoKind(p.kind) ? p.kind : 'other'] ?? 'Other').join(', ')}.
            </p>
          </div>
        )}

        <HandoverPhotoForm token={token} presentKinds={presentKinds} kinds={HANDOVER_PHOTO_KINDS} />

        <p style={{ marginTop: 32, fontSize: 12, color: '#9fb0c4' }}>
          Photos are stored on the operator's server. They are not shared with anyone outside the office.
        </p>
      </div>
    </main>
  );
}

function Notice({ kind, title, body }: { kind: 'error' | 'info'; title: string; body: string }) {
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
        <h1 style={{ fontSize: 22, marginBottom: 8, color: kind === 'error' ? '#e9c96a' : '#e9c96a' }}>{title}</h1>
        <p style={{ color: '#9fb0c4' }}>{body}</p>
      </div>
    </main>
  );
}