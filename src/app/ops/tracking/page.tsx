import { PageHeader, Card, CardTitle, Stat, Badge, Button, Table, Th, Td, EmptyState } from '@/components/ui';
import { HelpHint } from '@/components/HelpHint';
import { FleetMap } from '@/components/FleetMap';
import { getAuthContext } from '@/lib/auth/context';
import { livePositions } from '@/lib/gps';
import { fleetDriverLeaderboard } from '@/lib/telematics/scoring';
import { listRecentAlerts } from '@/lib/alerts/query';
import { ALERT_LABEL } from '@/lib/alerts/messages';
import { acknowledgeAlertAction } from '@/lib/actions/alerts';
import { relativeTime } from '@/lib/display';

export const dynamic = 'force-dynamic';

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function scoreTone(score: number): 'profit' | 'warn' | 'loss' {
  return score >= 85 ? 'profit' : score >= 65 ? 'warn' : 'loss';
}

export default async function TrackingPage() {
  const ctx = await getAuthContext();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [positions, leaderboard, alerts] = ctx?.tenantId
    ? await Promise.all([
        livePositions(ctx.tenantId),
        fleetDriverLeaderboard(ctx.tenantId, since),
        listRecentAlerts(ctx.tenantId, { limit: 50 }),
      ])
    : [[], [], []];
  const live = positions.filter((p) => minutesAgo(p.recorded_at) <= 10).length;
  const openAlerts = alerts.filter((a) => !a.acknowledged_at);

  return (
    <>
      <PageHeader
        eyebrow="Telematics"
        help="page.tracking"
        title="Live tracking"
        subtitle="Latest position per vehicle, from driver phones and hardware units. Vehicles entering an airport geofence auto-raise a drop-off charge."
        actions={<HelpHint id="tracking.devices" label="Tracking" />}
      />

      {/* 2-up before `sm` — three across overflowed the page at 320px (WCAG 1.4.10). */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat label="Tracked vehicles" value={positions.length} className="reveal" />
        <Stat label="Live (≤10 min)" value={live} tone="profit" className="reveal" />
        <Stat label="On a job" value={positions.filter((p) => p.booking_ref).length} className="reveal" />
      </section>

      {alerts.length > 0 && (
        <section className="mt-4">
          <Card className="p-0">
            <div className="flex items-baseline justify-between px-4 pt-4">
              <CardTitle>Owner alerts</CardTitle>
              <span className="text-xs text-muted">{openAlerts.length} open · last 50</span>
            </div>
            <Table caption="Owner vehicle alerts, newest first">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Vehicle</Th>
                  <Th>Owner</Th>
                  <Th>Alert</Th>
                  <Th>Sent</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className={a.acknowledged_at ? 'opacity-60' : undefined}>
                    <Td className="tnum">{relativeTime(a.occurred_at)}</Td>
                    <Td className="font-display text-cream">{a.vehicle.registration}</Td>
                    <Td>{a.owner?.name ?? '—'}</Td>
                    <Td>
                      <Badge tone={a.severity === 'critical' ? 'loss' : a.severity === 'warning' ? 'warn' : 'neutral'}>
                        {ALERT_LABEL[a.kind]}
                      </Badge>
                      {a.speed_kph != null && <span className="ml-2 text-xs text-muted">{Math.round(a.speed_kph)} km/h</span>}
                    </Td>
                    <Td className="text-xs text-muted">
                      {[a.notified_push_at && 'push', a.notified_sms_at && 'SMS'].filter(Boolean).join(' · ') || 'portal'}
                    </Td>
                    <Td className="text-right">
                      {a.acknowledged_at ? (
                        <span className="text-xs text-muted">acknowledged</span>
                      ) : (
                        <form action={acknowledgeAlertAction}>
                          <input type="hidden" name="alert_id" value={a.id} />
                          <Button type="submit" variant="ghost" size="sm" aria-label={`Acknowledge ${ALERT_LABEL[a.kind]} on ${a.vehicle.registration}`}>
                            Acknowledge
                          </Button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </section>
      )}

      {positions.length > 0 && (
        <section className="mt-4">
          <FleetMap positions={positions} />
        </section>
      )}

      <section className="mt-4">
        {positions.length === 0 ? (
          <EmptyState title="No positions yet" hint="Positions appear once a driver app or hardware unit sends GPS to /api/gps." />
        ) : (
          <Card className="p-0">
            <Table caption="Latest vehicle positions">
              <thead>
                <tr><Th>Vehicle</Th><Th>Position</Th><Th>Speed</Th><Th>On job</Th><Th>Last seen</Th></tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const mins = minutesAgo(p.recorded_at);
                  return (
                    <tr key={p.vehicle_id}>
                      <Td className="text-cream">{p.registration ?? '—'}</Td>
                      <Td className="font-mono text-xs">
                        <a
                          href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=15/${p.lat}/${p.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gold-bright hover:underline"
                          title="Open on map"
                        >
                          {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                        </a>
                      </Td>
                      <Td>{p.speed_mph != null ? `${Math.round(p.speed_mph)} mph` : '—'}</Td>
                      <Td>{p.booking_ref ? <span className="font-mono text-xs text-parchment">{p.booking_ref}</span> : '—'}</Td>
                      <Td><Badge tone={mins <= 10 ? 'profit' : 'neutral'}>{mins === 0 ? 'now' : `${mins} min ago`}</Badge></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        )}
      </section>

      {/* Driver behaviour league table (last 30 days, from position history) */}
      <section className="mt-6">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="font-display text-xl text-cream">Driver behaviour</h2>
          <span className="text-xs text-muted">last 30 days · from on-job tracking</span>
        </div>
        {leaderboard.length === 0 ? (
          <EmptyState title="No behaviour data yet" hint="Scores appear once tracked vehicles have logged on-job journeys." />
        ) : (
          <Card className="p-0">
            <Table caption="Driver behaviour scores">
              <thead>
                <tr>
                  <Th>Driver</Th><Th>Score</Th><Th className="text-right">Harsh accel</Th>
                  <Th className="text-right">Harsh brake</Th><Th className="text-right">Over 80mph</Th>
                  <Th className="text-right">Distance</Th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((d) => (
                  <tr key={d.driver_id}>
                    <Td className="text-cream">{d.driver_name ?? '—'}</Td>
                    <Td><Badge tone={scoreTone(d.score)}>{d.score}</Badge></Td>
                    <Td className="text-right tnum">{d.harsh_accel}</Td>
                    <Td className="text-right tnum">{d.harsh_brake}</Td>
                    <Td className="text-right tnum">{d.overspeed}</Td>
                    <Td className="text-right tnum">{d.distance_km} km</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Speeding is flagged above an absolute 80&nbsp;mph threshold, not the specific road limit.
        </p>
      </section>
    </>
  );
}
