import { Button } from '@/components/ui';
import { Icon, type IconName } from '@/components/icons';
import { getPublicPricing, type Plan } from '@/lib/billing';

/* ─────────────────────────────────────────────────────────────────────────────
   Elite Fleet Management — public marketing landing page.
   Server component: no client hooks, no client JS. Dark theme only.
   Reuses the app design system (globals.css tokens + ui/icons primitives).
   ──────────────────────────────────────────────────────────────────────────── */

const CAPABILITIES: { icon: IconName; title: string; line: string }[] = [
  {
    icon: 'car',
    title: 'Fleet & finance',
    line: 'Every vehicle with its lease, GFV and running-cost economics tracked to the penny.',
  },
  {
    icon: 'signature',
    title: 'Hire agreements',
    line: 'Standard hire and rent-to-buy contracts, generated, e-signed and versioned in one flow.',
  },
  {
    icon: 'shield',
    title: 'Drivers & compliance',
    line: 'MOT, insurance, PCO and DVLA reminders that chase themselves before anything lapses.',
  },
  {
    icon: 'alert',
    title: 'Charges',
    line: 'PCNs, congestion and toll charges captured and passed through to the right driver, automatically.',
  },
  {
    icon: 'pound',
    title: 'Payments & VAT',
    line: 'Rent collection, reconciliation and VAT-ready ledgers without the spreadsheet gymnastics.',
  },
  {
    icon: 'dashboard',
    title: 'GPS tracking & geofences',
    line: 'Live vehicle location, trip history and geofence alerts across the whole fleet.',
  },
  {
    icon: 'users',
    title: 'B2B bookings',
    line: 'Corporate accounts, standing bookings and account billing for your business clients.',
  },
  {
    icon: 'wallet',
    title: 'Driver portal',
    line: 'An installable app where drivers see agreements, balances, charges and documents.',
  },
];

const DIFFERENTIATORS: { icon: IconName; eyebrow: string; title: string; body: string; points: string[] }[] = [
  {
    icon: 'file',
    eyebrow: 'White-label',
    title: 'Your brand, not ours',
    body: 'Elite Fleet Management runs quietly in the background. Your operators, drivers and clients only ever see you.',
    points: [
      'Your logo and colours across the portal and driver app',
      'Contracts and letterheads issued under your company',
      'Branded transactional emails from your own domain',
    ],
  },
  {
    icon: 'trending',
    eyebrow: 'Intelligence',
    title: 'An AI assistant that knows your fleet',
    body: 'Built in and grounded strictly in your own operational data — never a generic model guessing. Use the assistant included with your plan, or bring your own AI provider and key.',
    points: [
      'Ask questions across vehicles, drivers, agreements and payments',
      'Generate board, investor and VAT reports on demand',
      'Included with your plan — or bring your own key. Your data is never shared across tenants.',
    ],
  },
  {
    icon: 'shield',
    eyebrow: 'Architecture',
    title: 'Built multi-tenant & compliant',
    body: 'Every operator is fully isolated at the data layer, with a complete audit trail behind every action.',
    points: [
      'Per-tenant isolation enforced at the database',
      'Immutable audit log of who changed what, and when',
      'Role-based access from principal down to driver',
    ],
  },
];

// `price`/`cadence` here are the OFFLINE FALLBACK only — the live figure is fetched
// from Stripe at render time (see getPublicPricing) so a price change on Stripe shows
// on the site without a redeploy. `plan` maps a tier to its Stripe price id.
const TIERS: {
  name: string;
  plan?: Plan;
  price: string;
  cadence: string;
  blurb: string;
  vehicles: string;
  features: string[];
  featured?: boolean;
}[] = [
  {
    name: 'Trial',
    price: 'Free',
    cadence: '',
    blurb: 'Kick the tyres',
    vehicles: 'Up to 3 vehicles',
    features: ['Full platform access', 'Agreements & drivers', 'Compliance reminders', 'No card required'],
  },
  {
    name: 'Starter',
    plan: 'starter',
    price: '£99',
    cadence: '/mo',
    blurb: 'For a growing yard',
    vehicles: 'Up to 10 vehicles',
    features: ['Everything in Trial', 'Payments & VAT ledgers', 'PCN & toll pass-through', 'Driver portal'],
  },
  {
    name: 'Growth',
    plan: 'growth',
    price: '£249',
    cadence: '/mo',
    blurb: 'For an established operator',
    vehicles: 'Up to 30 vehicles',
    features: ['Everything in Starter', 'GPS tracking & geofences', 'B2B corporate bookings', 'White-label branding'],
    featured: true,
  },
  {
    name: 'Scale',
    plan: 'scale',
    price: '£499',
    cadence: '/mo',
    blurb: 'For a serious fleet',
    vehicles: 'Up to 100 vehicles',
    features: ['Everything in Growth', 'AI assistant (included)', 'Board & investor reports', 'Priority support'],
  },
];

function Wordmark({ className, labelClassName }: { className?: string; labelClassName?: string }) {
  return (
    <div className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="h-8 w-8" />
      <span className={`font-display text-lg text-cream ${labelClassName ?? ''}`}>Elite Fleet Management</span>
    </div>
  );
}

export async function Landing() {
  // Live prices from Stripe (falls back to each tier's built-in figure if a plan
  // isn't resolvable — dev/CI without Stripe, or a transient Stripe error).
  const pricing = await getPublicPricing();
  return (
    <main id="main-content" tabIndex={-1} className="relative z-10">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-hair-soft">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Wordmark className="flex items-center gap-3" labelClassName="hidden sm:inline" />
          <nav aria-label="Site" className="flex shrink-0 items-center gap-3 sm:gap-5">
            <a href="/login" className="text-sm text-parchment transition-colors hover:text-cream">
              Sign in
            </a>
            <Button href="/request-access" size="sm">
              Request access
            </Button>
          </nav>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-hair-soft">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(1000px 520px at 78% -12%, rgba(184,151,42,0.14), transparent 62%), radial-gradient(760px 480px at -8% 8%, rgba(22,41,74,0.55), transparent 58%)',
          }}
        />
        <div className="relative mx-auto max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
          <div className="max-w-3xl">
            <p className="eyebrow">Fleet operations, unified</p>
            <h1 className="mt-5 font-display text-4xl leading-[1.05] text-cream sm:text-6xl">
              The operating system for private-hire and rental fleets.
            </h1>
            <div className="gold-rule mt-6" />
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-parchment">
              Run vehicles, agreements, drivers, compliance and payments in one system built for UK
              private-hire, chauffeur and vehicle-rental operators — under your own brand.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button href="/request-access">Request access</Button>
              <Button href="/login" variant="ghost">
                Sign in
              </Button>
            </div>
            <div className="mt-14 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
              <span className="text-cream">Vehicles</span>
              <span className="text-gold">·</span>
              <span className="text-cream">Agreements</span>
              <span className="text-gold">·</span>
              <span className="text-cream">Drivers</span>
              <span className="text-gold">·</span>
              <span className="text-cream">Compliance</span>
              <span className="ml-1 text-muted">— one system.</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Capabilities ───────────────────────────────────────────────────── */}
      <section className="border-b border-hair-soft">
        <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="eyebrow">Everything, in one place</p>
            <h2 className="mt-3 font-display text-3xl text-cream sm:text-4xl">
              The whole operation, not a point tool
            </h2>
            <div className="gold-rule mt-4" />
            <p className="mt-4 text-base text-muted">
              Elite Fleet Management replaces the tangle of spreadsheets, reminders and disconnected apps
              that fleet operators stitch together to stay compliant and get paid.
            </p>
          </div>

          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITIES.map((cap) => (
              <div key={cap.title} className="card-surface p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border border-hair text-gold-bright">
                  <Icon name={cap.icon} />
                </div>
                <h3 className="mt-5 text-lg text-cream">{cap.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{cap.line}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Differentiators ────────────────────────────────────────────────── */}
      <section className="border-b border-hair-soft">
        <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="eyebrow">Why operators choose it</p>
            <h2 className="mt-3 font-display text-3xl text-cream sm:text-4xl">
              Built for the way you actually run
            </h2>
            <div className="gold-rule mt-4" />
          </div>

          <div className="mt-14 space-y-4">
            {DIFFERENTIATORS.map((d) => (
              <div
                key={d.title}
                className="card-surface grid grid-cols-1 gap-8 p-8 sm:p-10 lg:grid-cols-[1.1fr_1fr] lg:items-center"
              >
                <div>
                  <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius)] border border-hair text-gold-bright">
                    <Icon name={d.icon} />
                  </div>
                  <p className="eyebrow mt-5">{d.eyebrow}</p>
                  <h3 className="mt-2 font-display text-2xl text-cream sm:text-3xl">{d.title}</h3>
                  <p className="mt-4 max-w-lg text-base leading-relaxed text-parchment">{d.body}</p>
                </div>
                <ul className="space-y-3">
                  {d.points.map((p) => (
                    <li key={p} className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border border-hair text-gold-bright">
                        <Icon name="check" className="h-3.5 w-3.5" />
                      </span>
                      <span className="text-sm leading-relaxed text-parchment">{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ────────────────────────────────────────────────────────── */}
      <section className="border-b border-hair-soft">
        <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
          <div className="max-w-2xl">
            <p className="eyebrow">Pricing</p>
            <h2 className="mt-3 font-display text-3xl text-cream sm:text-4xl">
              Priced by the size of your fleet
            </h2>
            <div className="gold-rule mt-4" />
            <p className="mt-4 text-base text-muted">
              Start free, then move up as you add vehicles. Every plan includes the full platform — the
              tiers simply scale with you.
            </p>
          </div>

          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TIERS.map((tier) => {
              // Live Stripe price when resolved; the tier's built-in figure otherwise.
              const live = tier.plan ? pricing[tier.plan] : undefined;
              const priceText = live?.amount ?? tier.price;
              const cadenceText = live?.cadence ?? tier.cadence;
              return (
              <div
                key={tier.name}
                className={
                  tier.featured
                    ? 'card-surface relative flex flex-col p-7 ring-1 ring-gold'
                    : 'card-surface relative flex flex-col p-7'
                }
              >
                {tier.featured && (
                  <span className="absolute -top-3 left-7 rounded-full border border-gold bg-ink px-3 py-1 text-[0.625rem] font-semibold uppercase tracking-wider text-gold-bright">
                    Most popular
                  </span>
                )}
                <p className="eyebrow text-parchment">{tier.name}</p>
                <p className="mt-1 text-xs text-muted">{tier.blurb}</p>
                <div className="mt-5 flex items-baseline gap-1">
                  <span className="font-display text-4xl text-cream tnum">{priceText}</span>
                  {cadenceText && <span className="text-sm text-muted">{cadenceText}</span>}
                </div>
                <p className="mt-3 text-sm font-semibold text-gold-bright">{tier.vehicles}</p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-parchment">
                      <Icon name="check" className="mt-0.5 h-4 w-4 flex-none text-gold" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-7">
                  <Button
                    href="/request-access"
                    variant={tier.featured ? 'primary' : 'outline'}
                    className="w-full"
                  >
                    Request access
                  </Button>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Closing CTA ────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-hair-soft">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(800px 400px at 50% 120%, rgba(184,151,42,0.14), transparent 60%)',
          }}
        />
        <div className="relative mx-auto max-w-3xl px-5 py-28 text-center sm:px-8">
          <div className="mx-auto gold-rule" />
          <h2 className="mt-6 font-display text-3xl leading-tight text-cream sm:text-5xl">
            Bring your whole fleet into one system.
          </h2>
          <p className="mt-5 text-lg text-parchment">
            See Elite Fleet Management running on your own vehicles, agreements and drivers.
          </p>
          <div className="mt-9 flex justify-center">
            <Button href="/request-access">Request access</Button>
          </div>
          <p className="mt-5 text-sm text-muted">Access is currently invitation-based.</p>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer>
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-5 py-12 sm:flex-row sm:items-center sm:px-8">
          <div>
            <Wordmark className="flex items-center gap-3" />
            <p className="mt-3 max-w-sm text-sm text-muted">
              The operating system for private-hire and rental fleets.
            </p>
          </div>
          <div className="text-xs text-muted sm:text-right">
            <nav className="flex flex-wrap gap-4">
              <a href="/terms" className="transition hover:text-cream">Terms</a>
              <a href="/privacy" className="transition hover:text-cream">Privacy</a>
              <a href="/acceptable-use" className="transition hover:text-cream">Acceptable Use</a>
            </nav>
            <p className="mt-3">© Elite Fleet Management · operated by Elite Solutions Hub Ltd</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
