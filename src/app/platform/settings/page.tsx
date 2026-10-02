import { requirePlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card, CardTitle, Button, Badge } from "@/components/ui";
import { saveSettingAction } from "@/lib/actions/collection";
import { collectionReadiness } from "@/lib/collection/readiness";
import { platformSettings } from "@/lib/collection/settings";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

/**
 * Operating settings for subscription collection: who issues the invoice, where
 * a transfer goes, and every day count in the ladder. Defaults live in
 * src/lib/collection/settings-defaults.ts; anything set here overrides them.
 */
export default async function PlatformSettingsPage() {
  // A layout is not an authorisation boundary in the App Router.
  await requirePlatformAdmin();
  const sb = createServiceClient();
  const [s, readiness] = await Promise.all([platformSettings(sb), collectionReadiness(sb)]);
  const issuer = s["invoice.issuer"];
  const bank = s["invoice.bank"];

  const numbers: { key: string; label: string; hint: string; value: number }[] = [
    { key: "collection.due_days_business", label: "Business invoice due in (days)", hint: "Fleets and insurers: initial, addition and one-off invoices.", value: s["collection.due_days_business"] },
    { key: "collection.renewal_issue_days", label: "Issue renewal (days before anniversary)", hint: "The renewal invoice is raised this many days ahead, at the then-current price.", value: s["collection.renewal_issue_days"] },
    { key: "collection.grace_days", label: "Grace after due (days)", hint: "Full service continues while we chase; then non-emergency service is suspended.", value: s["collection.grace_days"] },
    { key: "collection.cancel_days", label: "Cancel after due (days)", hint: "Counted from the anniversary. A cancellation warning goes out a week before.", value: s["collection.cancel_days"] },
    { key: "collection.additions_batch_day", label: "B2B additions batch day (of month)", hint: "Vehicles added mid-term on monthly-batch plans are invoiced pro-rata on this day.", value: s["collection.additions_batch_day"] },
  ];

  const hardwareNumbers: { key: string; label: string; hint: string; value: number }[] = [
    { key: "hardware.warranty_months", label: "Device warranty (months)", hint: "Free replacement within this long of fitting; outside it the customer is invoiced first.", value: s["hardware.warranty_months"] },
    { key: "hardware.install_sla_days", label: "Fitting SLA (days from payment)", hint: "Jobs past this are flagged overdue on the Hardware page.", value: s["hardware.install_sla_days"] },
    { key: "hardware.immobilise_max_speed_kph", label: "Engine cut: max speed (km/h)", hint: "An immobilise command is refused above this speed. Release is never gated.", value: s["hardware.immobilise_max_speed_kph"] },
    { key: "hardware.position_max_age_minutes", label: "Engine cut: max position age (minutes)", hint: "…and refused when the latest position is older than this.", value: s["hardware.position_max_age_minutes"] },
    { key: "hardware.first_ping_hours", label: "Silent after fitting (hours)", hint: "A fitted unit that has not reported within this long is flagged on the readiness page.", value: s["hardware.first_ping_hours"] },
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform" title="Collection settings" subtitle="Nothing about money is hardcoded: issuer, bank account, reminder timing and the suspension ladder all live here." />

      <Card>
        <CardTitle>Readiness</CardTitle>
        {!readiness.applies ? (
          <p className="mt-2 text-sm text-muted">This instance is not a pay-first market; collection settings do not apply.</p>
        ) : readiness.ok ? (
          <p className="mt-2 text-sm text-parchment">
            <Badge tone="profit">ready</Badge> Issuer set, gateway configured ({readiness.gateways.join(", ")}), every active plan and item priced.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-parchment">
            {readiness.reasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span className="text-[var(--color-loss)]">•</span>
                <span>{r}</span>
              </li>
            ))}
            <li className="text-muted">Gateways configured on this instance: {readiness.gateways.length ? readiness.gateways.join(", ") : "none"} (env: PAYSTACK_SECRET_KEY / FLUTTERWAVE_SECRET_KEY).</li>
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>Invoice issuer</CardTitle>
        <p className="mb-3 text-sm text-muted">Printed on every invoice and receipt. The legal entity, tax and VAT numbers are a go-live decision — set them before the first real invoice.</p>
        <form action={saveSettingAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="key" value="invoice.issuer" />
          <Field label="Legal name"><input name="legalName" defaultValue={issuer.legalName} className={`${inputCls} w-full`} /></Field>
          <Field label="Tax identification number (TIN)"><input name="tin" defaultValue={issuer.tin} className={`${inputCls} w-full`} /></Field>
          <Field label="VAT registration number"><input name="vatNumber" defaultValue={issuer.vatNumber} className={`${inputCls} w-full`} /></Field>
          <Field label="Billing email"><input name="email" type="email" defaultValue={issuer.email} className={`${inputCls} w-full`} /></Field>
          <Field label="Billing phone"><input name="phone" defaultValue={issuer.phone} className={`${inputCls} w-full`} /></Field>
          <Field label="Address"><textarea name="address" defaultValue={issuer.address} rows={2} className={`${inputCls} w-full`} /></Field>
          <div className="sm:col-span-2"><Button type="submit" size="sm">Save issuer</Button></div>
        </form>
      </Card>

      <Card>
        <CardTitle>Bank account for transfers</CardTitle>
        <form action={saveSettingAction} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <input type="hidden" name="key" value="invoice.bank" />
          <Field label="Bank"><input name="bankName" defaultValue={bank.bankName} className={`${inputCls} w-full`} /></Field>
          <Field label="Account name"><input name="accountName" defaultValue={bank.accountName} className={`${inputCls} w-full`} /></Field>
          <Field label="Account number"><input name="accountNumber" defaultValue={bank.accountNumber} className={`${inputCls} w-full`} inputMode="numeric" /></Field>
          <div className="sm:col-span-3"><Button type="submit" size="sm">Save bank details</Button></div>
        </form>
      </Card>

      <Card>
        <CardTitle>The ladder</CardTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {numbers.map((n) => (
            <form key={n.key} action={saveSettingAction} className="flex items-end gap-2">
              <input type="hidden" name="key" value={n.key} />
              <Field label={n.label} hint={n.hint}>
                <input name="value" type="number" min="0" defaultValue={n.value} className={`${inputCls} w-32`} />
              </Field>
              <Button type="submit" variant="outline" size="sm">Save</Button>
            </form>
          ))}
          <form action={saveSettingAction} className="flex items-end gap-2">
            <input type="hidden" name="key" value="collection.reminder_days_before" />
            <Field label="Reminders before due (days, comma-separated)" hint="Renewal reminders; each fires once inside its own window.">
              <input name="value" defaultValue={s["collection.reminder_days_before"].join(", ")} className={`${inputCls} w-48`} />
            </Field>
            <Button type="submit" variant="outline" size="sm">Save</Button>
          </form>
          <form action={saveSettingAction} className="flex items-end gap-2">
            <input type="hidden" name="key" value="collection.reminder_days_after" />
            <Field label="Reminders after due (days, comma-separated)" hint="Overdue reminders for any unpaid invoice.">
              <input name="value" defaultValue={s["collection.reminder_days_after"].join(", ")} className={`${inputCls} w-48`} />
            </Field>
            <Button type="submit" variant="outline" size="sm">Save</Button>
          </form>
          <form action={saveSettingAction} className="flex items-end gap-2">
            <input type="hidden" name="key" value="collection.preferred_gateway" />
            <Field label="Preferred gateway" hint="Only a configured gateway is used; blank follows the market's order.">
              <select name="value" defaultValue={s["collection.preferred_gateway"] ?? ""} className={inputCls}>
                <option value="">market order</option>
                <option value="paystack">Paystack</option>
                <option value="flutterwave">Flutterwave</option>
              </select>
            </Field>
            <Button type="submit" variant="outline" size="sm">Save</Button>
          </form>
        </div>
      </Card>

      <Card>
        <CardTitle>Hardware (NG-3)</CardTitle>
        <p className="mb-3 text-sm text-muted">
          Warranty, fitting SLA, the safety gate on an engine cut, and the installer&apos;s checklist. Prices for devices, installation and replacement live in the
          Catalogue; installer fees on each installer.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {hardwareNumbers.map((n) => (
            <form key={n.key} action={saveSettingAction} className="flex items-end gap-2">
              <input type="hidden" name="key" value={n.key} />
              <Field label={n.label} hint={n.hint}>
                <input name="value" type="number" min="0" defaultValue={n.value} className={`${inputCls} w-32`} />
              </Field>
              <Button type="submit" variant="outline" size="sm">Save</Button>
            </form>
          ))}
          <form action={saveSettingAction} className="flex items-end gap-2 sm:col-span-2">
            <input type="hidden" name="key" value="hardware.checklist" />
            <Field label="Installer checklist (one item per line)" hint="Every item must be ticked before a fitting is marked done.">
              <textarea name="value" rows={6} defaultValue={s["hardware.checklist"].join("\n")} className={`${inputCls} w-full min-w-[20rem]`} />
            </Field>
            <Button type="submit" variant="outline" size="sm">Save</Button>
          </form>
        </div>
      </Card>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
