import { Button } from '@/components/ui';
import { listCatalogue, listPlanOneOffs } from '@/lib/catalogue/manage';
import { regionOf } from '@/lib/catalogue/region';
import { isUnpriced, isUnpricedItem, type Interval } from '@/lib/collection/pricing';
import { deploymentBrand } from '@/lib/deployment/brand';
import { deploymentProfile } from '@/lib/deployment/profile';
import { formatMoney } from '@/lib/money';

/* ─────────────────────────────────────────────────────────────────────────────
   The shared instance's front door: what protection an individual owner gets
   and what it costs, read LIVE from the catalogue. No price lives in this file.
   Server component, dark theme, same primitives as the SaaS landing.
   Wording: tracking, alerts, a monthly report, and a team that acts on
   emergencies — never "recovery" (NG-4 §12).
   ──────────────────────────────────────────────────────────────────────────── */

const FEATURE_LABEL: Record<string, string> = {
  'gps.phone': 'Where your car is, in the app',
  'gps.hardware': 'A fitted GPS tracker',
  'notifications.sms': 'SMS alerts: night movement, speeding, leaving home',
  'notifications.push': 'Phone notifications',
  'notifications.email': 'Email alerts',
  compliance: 'Licence, roadworthiness and insurance reminders',
  documents: 'Your documents in one place',
  fuel: 'Fuel log',
  'gps.immobilise': 'Remote immobilisation on request',
  'insurance.claims': 'Claims support',
  'ai.optimiser': 'Trip insights',
  'reports.director': 'Detailed monthly report',
  'fleet.core': 'Vehicle records',
};

interface Tier {
  name: string;
  terms: { interval: Interval; perVehicleMinor: number; label: string }[];
  features: string[];
  oneOffs: { name: string; minor: number }[];
  sort: number;
}

export async function NigeriaLanding() {
  const brand = deploymentBrand();
  const region = deploymentProfile().region;
  const [{ plans, addons }, oneOffsOf] = await Promise.all([listCatalogue(undefined, { region, audience: 'individual' }), listPlanOneOffs()]);
  const items = new Map(addons.filter((a) => a.kind === 'one_off' && a.active).map((a) => [a.id, a]));
  // Plan keys are ng_<tier>_<term>; group the terms under the tier.
  const tiers = new Map<string, Tier>();
  for (const p of plans) {
    if (!p.active || !p.per_vehicle || isUnpriced(p) || regionOf(p) !== region) continue;
    const tierKey = p.key.split('_')[1] ?? p.key;
    const name = p.name.replace(/\s*\((annual|6 months|year)\)\s*$/i, '');
    const t = tiers.get(tierKey) ?? { name, terms: [], features: [], oneOffs: [], sort: p.sort };
    const interval = p.interval as Interval;
    t.terms.push({ interval, perVehicleMinor: p.base_price_pence, label: interval === 'year' ? 'per year' : interval === 'half_year' ? 'per 6 months' : 'per month' });
    if (!t.features.length) {
      const { data: pf } = await (await import('@/lib/supabase/server')).createServiceClient().from('plan_features').select('feature_key').eq('plan_id', p.id);
      t.features = (pf ?? []).map((r) => r.feature_key);
    }
    if (!t.oneOffs.length) {
      t.oneOffs = [...(oneOffsOf.get(p.id) ?? [])]
        .map((id) => items.get(id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a) && !isUnpricedItem(a as { unit_price_pence: number }))
        .map((a) => ({ name: a.name, minor: a.unit_price_pence }));
    }
    tiers.set(tierKey, t);
  }
  const list = [...tiers.values()].sort((a, b) => a.sort - b.sort);
  const fmt = (minor: number) => formatMoney(minor, { region, showMinor: false });

  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:px-8">
      <p className="eyebrow">{brand.productName}</p>
      <h1 className="mt-2 font-display text-3xl text-cream sm:text-4xl">Know where your car is. Every hour, every night.</h1>
      <p className="mt-3 max-w-2xl text-parchment">
        Vehicle protection for individual owners in Nigeria: live location, alerts when your car moves at night, speeds or leaves home, a monthly
        report, and a team you can reach the moment something is wrong. Pay once for the term; protection switches on when your payment is
        confirmed.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button href="/login">Start with your phone number</Button>
        <Button href="/login" variant="ghost">
          Already protected? Sign in
        </Button>
      </div>

      <section className="mt-12" aria-labelledby="plans">
        <h2 id="plans" className="font-display text-2xl text-cream">
          Plans, per vehicle
        </h2>
        {list.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Pricing is being finalised. Sign in with your phone number and we will tell you when plans open.</p>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {list.map((t) => (
              <article key={t.name} className="rounded-lg border border-hair p-5">
                <h3 className="font-display text-xl text-cream">{t.name}</h3>
                <ul className="mt-2 space-y-1">
                  {t.terms
                    .sort((a, b) => (a.interval === 'year' ? -1 : 1))
                    .map((term) => (
                      <li key={term.interval} className="text-sm text-parchment">
                        <span className="tnum text-lg text-cream">{fmt(term.perVehicleMinor)}</span> {term.label}
                        <span className="text-muted"> + VAT</span>
                      </li>
                    ))}
                </ul>
                <ul className="mt-4 space-y-1 text-sm text-parchment">
                  {t.features.slice(0, 7).map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="text-gold-bright">✓</span>
                      <span>{FEATURE_LABEL[f] ?? f}</span>
                    </li>
                  ))}
                </ul>
                {t.oneOffs.length > 0 && (
                  <p className="mt-4 text-xs text-muted">One-off at fitting: {t.oneOffs.map((o) => `${o.name} ${fmt(o.minor)}`).join(' · ')}</p>
                )}
              </article>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs text-muted">Prices are per vehicle and exclude 7.5% VAT. Hardware is fitted by our team after payment. Annual and six-month terms; no monthly billing.</p>
      </section>

      <section className="mt-12 grid gap-6 sm:grid-cols-3" aria-label="How it works">
        {[
          ['1. Sign in with your phone', 'A one-time code by SMS. No app to install.'],
          ['2. Add your car and pay', 'Card, bank transfer or USSD. Protection starts when the payment is confirmed.'],
          ['3. We fit the tracker', 'On Gold and Platinum our team fits the device; alerts start the same day.'],
        ].map(([h, p]) => (
          <div key={h}>
            <h3 className="font-display text-lg text-cream">{h}</h3>
            <p className="mt-1 text-sm text-parchment">{p}</p>
          </div>
        ))}
      </section>

      <footer className="mt-12 border-t border-hair pt-4 text-xs text-muted">
        {brand.footnote} · Alerts and a monthly report tell you what your vehicle did; emergencies reach our on-call team by phone and app. We do not
        promise recovery of a stolen vehicle.
      </footer>
    </main>
  );
}
