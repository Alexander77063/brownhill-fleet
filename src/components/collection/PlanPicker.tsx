import { regionOf } from "@/lib/catalogue/region";
import type { PlanOffer } from "@/lib/collection/owner-billing";
import { formatMoney } from "@/lib/money";

const FEATURE_LABEL: Record<string, string> = {
  "fleet.core": "Vehicle records",
  compliance: "Renewal reminders",
  documents: "Documents",
  "gps.phone": "Location in the app",
  "gps.hardware": "Fitted GPS tracker",
  "notifications.email": "Email alerts",
  "notifications.sms": "SMS alerts",
  "notifications.push": "Phone notifications",
  fuel: "Fuel log",
  "gps.immobilise": "Remote immobilisation",
  "insurance.claims": "Claims support",
  "ai.optimiser": "Trip insights",
  "reports.director": "Detailed reports",
};

/** Radio cards for the plans on offer, priced for the owner's own vehicles. Server-rendered; the form around it posts plan_id. */
export function PlanPicker({ offers, vehicles, currentPlanId }: { offers: PlanOffer[]; vehicles: number; currentPlanId: string | null }) {
  if (offers.length === 0) {
    return <p className="text-sm text-muted">No plans are on sale yet. Please check back shortly.</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {offers.map((o, i) => {
        const region = regionOf(o.plan);
        const fmt = (minor: number) => formatMoney(minor, { region, showMinor: false });
        const current = o.plan.id === currentPlanId;
        return (
          <label key={o.plan.id} className={`block cursor-pointer rounded-lg border p-4 ${current ? "border-gold-bright" : "border-hair hover:border-gold-bright/60"}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-display text-lg text-cream">{o.plan.name}</p>
                <p className="text-sm text-parchment">
                  <span className="tnum text-cream">{fmt(o.perVehicleMinor)}</span> per vehicle {o.termLabel}
                  <span className="text-muted"> + VAT</span>
                </p>
              </div>
              <input type="radio" name="plan_id" value={o.plan.id} defaultChecked={current || (currentPlanId === null && i === 0)} aria-label={`Choose ${o.plan.name}`} className="mt-1" />
            </div>
            <ul className="mt-3 space-y-1 text-sm text-parchment">
              {o.features.slice(0, 7).map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="text-gold-bright">✓</span>
                  <span>{FEATURE_LABEL[f] ?? f}</span>
                </li>
              ))}
            </ul>
            {o.oneOffs.length > 0 && (
              <p className="mt-3 text-xs text-muted">
                One-off, per vehicle: {o.oneOffs.map((a) => `${a.name} ${fmt(a.unit_price_pence)}`).join(" · ")}
              </p>
            )}
            {o.preview && (
              <p className="mt-3 border-t border-hair-soft pt-2 text-sm text-cream">
                First payment for {vehicles} vehicle{vehicles === 1 ? "" : "s"}: <span className="tnum">{formatMoney(o.preview.grossMinor, { region })}</span>
                <span className="text-muted"> incl. VAT</span>
              </p>
            )}
            {current && <p className="mt-2 text-xs text-gold-bright">Your current plan</p>}
          </label>
        );
      })}
    </div>
  );
}
