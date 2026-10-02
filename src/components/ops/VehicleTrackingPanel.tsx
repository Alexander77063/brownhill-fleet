'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardTitle, Button, Badge } from '@/components/ui';
import { provisionDeviceAction, removeDeviceAction, immobiliseAction } from '@/lib/actions/tracking';

interface Device {
  kind: 'phone' | 'hardware';
  label: string | null;
  is_active: boolean;
  /** NG-3: fitted-unit facts, when the device is a unit we fitted. */
  state?: string;
  imei?: string | null;
  fittedAt?: string | null;
  warrantyUntil?: string | null;
  firstPingAt?: string | null;
  hasImmobiliser?: boolean;
}
interface Immob {
  requested: 'immobilise' | 'release' | null;
  status: string | null;
  hardwareConnected: boolean;
  unavailableReason?: string | null;
}

const UNAVAILABLE: Record<string, string> = {
  'no-device': 'No tracker is fitted to this vehicle.',
  'no-relay': 'The fitted tracker has no immobiliser relay.',
  'no-traccar': 'The tracking gateway is not configured.',
  'not-registered': 'The fitted unit is not registered with the gateway yet.',
};

export function VehicleTrackingPanel({
  vehicleId,
  canPhone,
  canHardware,
  canImmobilise,
  device,
  immob,
}: {
  vehicleId: string;
  canPhone: boolean;
  canHardware: boolean;
  canImmobilise: boolean;
  device: Device | null;
  immob: Immob;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function run(fn: () => Promise<{ error?: string }>) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  function add(kind: 'phone' | 'hardware') {
    setError(null);
    setToken(null);
    start(async () => {
      const r = await provisionDeviceAction(vehicleId, kind);
      if (r.error) setError(r.error);
      else {
        setToken(r.token ?? null);
        router.refresh();
      }
    });
  }

  function requestEngine(action: 'immobilise' | 'release') {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await immobiliseAction(vehicleId, action);
      if (r.error) setError(r.error);
      else {
        setNotice(
          action === 'immobilise'
            ? 'Engine-cut request sent. Our on-call team will verify it with the owner and send the command once the vehicle is stopped.'
            : 'Release request sent to our on-call team.',
        );
        router.refresh();
      }
    });
  }

  const immobilised = immob.requested === 'immobilise' && immob.status !== 'failed';
  const fittedUnit = device?.kind === 'hardware' && Boolean(device.imei);

  return (
    <Card>
      <CardTitle>Tracking &amp; control</CardTitle>

      {/* Device */}
      <div className="mt-3">
        <p className="eyebrow text-parchment">Tracking device</p>
        {device ? (
          <div className="mt-2">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={device.kind === 'hardware' ? 'gold' : 'neutral'}>
                {device.kind === 'hardware' ? 'Hardware tracker' : 'Driver app'}
              </Badge>
              {device.label && <span className="text-sm text-muted">{device.label}</span>}
              {device.imei && <span className="tnum text-xs text-muted">IMEI {device.imei}</span>}
              <Badge tone={device.is_active ? 'profit' : 'neutral'}>{device.is_active ? 'Active' : 'Inactive'}</Badge>
              {device.hasImmobiliser && <Badge tone="gold">immobiliser relay</Badge>}
              {!fittedUnit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={pending}
                  onClick={() => run(() => removeDeviceAction(vehicleId))}
                >
                  Remove
                </Button>
              )}
            </div>
            {fittedUnit && (
              <p className="mt-2 text-xs text-muted">
                {device.fittedAt ? `Fitted ${device.fittedAt.slice(0, 10)}` : 'Fitting pending'}
                {device.warrantyUntil ? ` · warranty to ${device.warrantyUntil}` : ''}
                {device.firstPingAt ? '' : ' · has not reported yet'}
                {' · '}Removal or replacement is a hardware job — raise it with support.
              </p>
            )}
          </div>
        ) : canPhone || canHardware ? (
          <div className="mt-2">
            <p className="text-sm text-muted">
              No tracker registered yet. Enable driver-app tracking (no hardware), or register a hardware
              GPS unit that POSTs positions to <code className="text-parchment">/api/gps</code>. Each issues a
              per-vehicle token. Trackers we fit appear here automatically once the fitting job is done.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {canPhone && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => add('phone')}>
                  {pending ? 'Working…' : 'Enable driver-app tracking'}
                </Button>
              )}
              {canHardware && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => add('hardware')}>
                  {pending ? 'Working…' : 'Add hardware tracker'}
                </Button>
              )}
            </div>
            {!canHardware && (
              <p className="mt-2 text-xs text-muted">
                Hardware GPS is on <span className="text-cream">Growth</span> and{' '}
                <span className="text-cream">Scale</span> — or add it à la carte.{' '}
                <a href="/admin" className="text-gold-bright hover:underline">Upgrade or add-on</a>
              </p>
            )}
          </div>
        ) : (
          <div className="mt-2 rounded-[var(--radius)] border border-hair bg-[var(--surface)] px-3 py-2.5">
            <p className="text-sm text-muted">Vehicle tracking isn&apos;t included in this plan.</p>
            <Button href="/admin" size="sm" variant="outline" className="mt-2">
              Upgrade or add-on
            </Button>
          </div>
        )}

        {token && (
          <div className="mt-3 rounded-[var(--radius)] border border-[var(--color-gold)] bg-[var(--surface)] p-3">
            <p className="text-xs font-semibold text-gold-bright">Device token — shown once, copy it now</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="block flex-1 overflow-x-auto whitespace-nowrap rounded bg-[var(--surface-strong)] px-2 py-1.5 text-xs text-cream">
                {token}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(token).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Send it as the <code className="text-parchment">X-Device-Token</code> header on each position POST.
            </p>
          </div>
        )}
      </div>

      {/* Immobilisation */}
      <div className="mt-5 border-t border-hair-soft pt-4">
        <p className="eyebrow text-parchment">Immobilisation</p>
        {canImmobilise ? (
          <div className="mt-2">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={immobilised ? 'loss' : 'profit'}>
                {immobilised ? `Engine cut ${immob.status ?? 'requested'}` : 'Mobile'}
              </Badge>
              <Button
                size="sm"
                variant={immobilised ? 'outline' : 'primary'}
                disabled={pending || immobilised || !immob.hardwareConnected}
                onClick={() => requestEngine('immobilise')}
              >
                Request engine cut
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !immobilised}
                onClick={() => requestEngine('release')}
              >
                Request release
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">
              Only our on-call team sends an engine command, after verifying the request with the owner and
              only while the vehicle is stopped. Your request pages them immediately.
            </p>
            {!immob.hardwareConnected && (
              <p className="mt-2 text-xs text-[var(--color-warn)]">
                {UNAVAILABLE[immob.unavailableReason ?? ''] ?? 'No immobilisation hardware is connected for this vehicle.'}
              </p>
            )}
          </div>
        ) : (
          <div className="mt-2 rounded-[var(--radius)] border border-hair bg-[var(--surface)] px-3 py-2.5">
            <p className="text-sm text-muted">
              Remote immobilisation is on <span className="text-cream">Scale</span> — or add it à la carte.
            </p>
            <Button href="/admin" size="sm" variant="outline" className="mt-2">
              Upgrade or add-on
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <p role="status" className="mt-3 text-sm text-parchment">
          {notice}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-[var(--color-loss)]">{error}</p>}
    </Card>
  );
}
