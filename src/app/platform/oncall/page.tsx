import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Badge, Button, Table, Th, Td } from "@/components/ui";
import { PushOptIn } from "@/components/PushOptIn";
import { listOnCall, escalationConfigured } from "@/lib/requests";
import { removeOnCallAction, testCallAction, upsertOnCallAction } from "@/lib/actions/requests";
import { regionProvider } from "@/lib/region";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export default async function OnCallPage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const [roster, readiness] = await Promise.all([listOnCall(), escalationConfigured()]);
  const example = regionProvider().phone.example;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="On-call"
        title="Who gets called"
        subtitle="Stolen-vehicle and immobilise requests push to every admin, text this roster, and call priority 1 first — every five minutes until someone acknowledges."
      />

      <Card>
        <CardTitle>Readiness</CardTitle>
        <ul className="grid gap-2 text-sm sm:grid-cols-4">
          <li>
            <Badge tone={readiness.oncall > 0 ? "profit" : "loss"}>{readiness.oncall} on call</Badge>
          </li>
          <li>
            <Badge tone={readiness.sms ? "profit" : "loss"}>SMS {readiness.sms ? "ready" : "not configured"}</Badge>
          </li>
          <li>
            <Badge tone={readiness.voice ? "profit" : "warn"}>Voice {readiness.voice ? "ready" : "not configured"}</Badge>
          </li>
          <li>
            <Badge tone={readiness.push ? "profit" : "warn"}>Push {readiness.push ? "ready" : "not configured"}</Badge>
          </li>
        </ul>
        {readiness.broken && (
          <p className="mt-3 text-sm text-[var(--color-loss)]">Escalation is not configured — emergencies are not reaching anyone. Add at least one active on-call phone and set the SMS or voice provider.</p>
        )}
      </Card>

      <Card className="p-0">
        <div className="px-4 pt-4">
          <CardTitle>Roster</CardTitle>
        </div>
        <Table caption="On-call roster">
          <thead>
            <tr>
              <Th>Priority</Th>
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Active</Th>
              <Th>{""}</Th>
            </tr>
          </thead>
          <tbody>
            {roster.map((r) => (
              <tr key={r.id}>
                <Td className="tnum">{r.priority}</Td>
                <Td className="text-cream">{r.name}</Td>
                <Td>{r.phone}</Td>
                <Td>{r.active ? <Badge tone="profit">active</Badge> : <span className="text-muted">off</span>}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <form action={testCallAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" variant="outline" size="sm" aria-label={`Test call ${r.name}`}>
                        Test call
                      </Button>
                    </form>
                    <form action={removeOnCallAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" variant="ghost" size="sm" aria-label={`Remove ${r.name} from the roster`}>
                        Remove
                      </Button>
                    </form>
                  </div>
                </Td>
              </tr>
            ))}
            {roster.length === 0 && (
              <tr>
                <Td className="text-muted">Nobody on call yet.</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>

      <Card className="max-w-xl">
        <CardTitle>Add to the roster</CardTitle>
        <form action={upsertOnCallAction} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Name</span>
            <input name="name" required className={`${inputCls} w-full`} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Mobile</span>
            <input name="phone" type="tel" required placeholder={example} className={`${inputCls} w-full`} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Priority</span>
            <input name="priority" type="number" min="1" max="10" defaultValue={roster.length + 1} className={`${inputCls} w-full`} />
          </label>
          <div className="self-end sm:col-span-3">
            <Button type="submit" variant="primary" size="sm">
              Add
            </Button>
          </div>
        </form>
      </Card>

      <Card className="max-w-xl">
        <CardTitle>Push to this device</CardTitle>
        <p className="mb-3 text-sm text-muted">Every admin who turns this on gets the emergency notification on their phone the moment a request is raised.</p>
        <PushOptIn />
      </Card>
    </div>
  );
}
