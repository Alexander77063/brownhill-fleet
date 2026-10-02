import { PageHeader, Card, CardTitle, Badge, Button } from '@/components/ui';
import { myVehicles } from '@/lib/owner-portal';
import { listOwnerRequests, REQUEST_LABEL, REQUEST_KINDS } from '@/lib/requests';
import { raiseOwnerRequestAction } from '@/lib/actions/requests';
import { relativeTime } from '@/lib/display';

export const dynamic = 'force-dynamic';

const inputCls =
  'w-full rounded-md border border-hair bg-[var(--surface)] px-3 py-2.5 text-base text-cream focus:border-gold-bright focus:outline-none';

const STATUS_TONE: Record<string, 'warn' | 'profit' | 'neutral'> = { open: 'warn', acknowledged: 'profit', closed: 'neutral' };
const STATUS_TEXT: Record<string, string> = {
  open: 'Sent — we are being alerted',
  acknowledged: 'A person has picked this up',
  closed: 'Closed',
};

export default async function OwnerHelpPage({ searchParams }: { searchParams: Promise<{ raised?: string }> }) {
  const { raised } = await searchParams;
  const [vehicles, requests] = await Promise.all([myVehicles(), listOwnerRequests()]);

  return (
    <>
      <PageHeader eyebrow="Help" title="Ask for help" subtitle="If your vehicle has been stolen or needs immobilising, tell us here. A person at our end is alerted straight away." />

      {raised && (
        <p role="status" className="mb-4 rounded-md border border-hair bg-[var(--surface)] px-3 py-2 text-sm text-parchment">
          We have your request. For a stolen vehicle we are calling our on-call team now.
        </p>
      )}

      <Card className="max-w-xl">
        <CardTitle>What do you need?</CardTitle>
        <form action={raiseOwnerRequestAction} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Choose one</legend>
            {REQUEST_KINDS.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-3 rounded-md border border-hair px-3 py-3 text-base text-cream has-[:checked]:border-gold-bright">
                <input type="radio" name="kind" value={k} required className="h-5 w-5" /> {REQUEST_LABEL[k]}
              </label>
            ))}
          </fieldset>
          {vehicles.length > 0 && (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Which vehicle</span>
              <select name="vehicle_id" className={inputCls} defaultValue={vehicles.length === 1 ? vehicles[0].id : ''}>
                {vehicles.length > 1 && <option value="">Choose…</option>}
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.registration} · {v.make} {v.model}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Anything we should know (optional)</span>
            <textarea name="note" rows={3} maxLength={500} className={inputCls} placeholder="Where it was, when you last saw it, who to call back" />
          </label>
          <Button type="submit" variant="primary" className="w-full sm:w-auto">
            Send to our team
          </Button>
        </form>
      </Card>

      {requests.length > 0 && (
        <Card className="mt-6 max-w-xl">
          <CardTitle>Your requests</CardTitle>
          <ul className="divide-y divide-hair">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span className="text-cream">
                  {REQUEST_LABEL[r.kind]}
                  {r.registration ? ` · ${r.registration}` : ''}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {relativeTime(r.createdAt)} <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{STATUS_TEXT[r.status] ?? r.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
