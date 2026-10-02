'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui';
import { LEGAL_VERSION } from '@/lib/legal';

const inputCls =
  'w-full rounded-[var(--radius)] border border-hair-soft bg-navy px-3 py-2.5 text-cream placeholder:text-muted focus:border-gold focus:outline-none';

export default function RequestAccessPage() {
  const [company, setCompany] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fleetSize, setFleetSize] = useState('');
  const [message, setMessage] = useState('');
  const honeypotRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/signup-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          company,
          contact_name: contactName,
          email,
          phone,
          fleet_size: fleetSize,
          message,
          terms_version: LEGAL_VERSION,
          website: honeypotRef.current?.value ?? '',
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? 'Could not submit your request. Please try again.');
      }
      setDone(true);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="grid min-h-dvh lg:grid-cols-2">
      {/* Brand panel */}
      <section className="relative hidden flex-col justify-between overflow-hidden p-12 lg:flex">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(900px 500px at 20% 10%, rgba(184,151,42,0.16), transparent 60%), linear-gradient(160deg,#0f1d33,#060b14)',
          }}
        />
        <div className="relative z-10 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-12 w-12" />
          <div>
            <p className="font-display text-xl text-cream">Elite Fleet Management</p>
            <p className="eyebrow">Fleet Operating System</p>
          </div>
        </div>
        <div className="relative z-10 max-w-md">
          <div className="gold-rule mb-5" />
          <h1 className="font-display text-4xl leading-tight text-cream">
            Bring your fleet under refined command.
          </h1>
          <p className="mt-4 text-sm text-muted">
            Tell us a little about your operation and we&apos;ll set up a workspace tailored to your
            fleet — vehicles, agreements, drivers, compliance and payments in one system, under your
            own brand.
          </p>
        </div>
        <p className="relative z-10 text-xs text-muted">Multi-tenant · White-label · UK-ready</p>
      </section>

      {/* Form panel */}
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" className="h-10 w-10" />
            <p className="font-display text-lg text-cream">Elite Fleet Management</p>
          </div>

          <p className="eyebrow">Get started</p>
          <h2 className="mt-1 font-display text-3xl text-cream">Request access</h2>
          <div className="gold-rule mt-3 mb-6" />

          {done ? (
            <div className="space-y-4">
              <p className="text-sm text-[var(--color-profit)]">
                Thanks — we&apos;ve got your request and will be in touch.
              </p>
              <p className="text-sm text-muted">
                A member of our team will reach out to the email you provided to set up your
                workspace.
              </p>
              <Button href="/login" variant="outline" className="w-full">
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {/* Honeypot — hidden from users; bots that fill it are silently trapped. */}
              <input
                ref={honeypotRef}
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                style={{ position: 'absolute', left: '-9999px' }}
              />

              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Company *</span>
                <input
                  type="text"
                  required
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Elite Chauffeurs Ltd"
                  className={inputCls}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Contact name</span>
                <input
                  type="text"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Jane Doe"
                  className={inputCls}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Email *</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.co.uk"
                  className={inputCls}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Phone</span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+44 7700 900000"
                  className={inputCls}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Fleet size</span>
                <select
                  value={fleetSize}
                  onChange={(e) => setFleetSize(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Select…</option>
                  <option value="1-5">1–5 vehicles</option>
                  <option value="6-20">6–20 vehicles</option>
                  <option value="21-50">21–50 vehicles</option>
                  <option value="50+">50+ vehicles</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-parchment">Message</span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  placeholder="Tell us about your fleet and what you're looking for."
                  className={`${inputCls} resize-y`}
                />
              </label>

              <label className="flex items-start gap-2 text-xs text-muted">
                <input type="checkbox" required className="mt-0.5 accent-[var(--color-gold)]" />
                <span>
                  I agree to the{' '}
                  <Link href="/terms" target="_blank" className="text-gold-bright hover:underline">
                    Terms of Service
                  </Link>{' '}
                  and{' '}
                  <Link href="/privacy" target="_blank" className="text-gold-bright hover:underline">
                    Privacy Policy
                  </Link>
                  .
                </span>
              </label>

              <Button type="submit" disabled={busy} className="w-full">
                {busy ? 'Submitting…' : 'Request access'}
              </Button>

              {err && <p className="text-sm text-[var(--color-loss)]">{err}</p>}
            </form>
          )}

          <p className="mt-8 text-xs text-muted">
            Already have an account?{' '}
            <Link href="/login" className="text-gold-bright hover:underline">
              Sign in
            </Link>
          </p>
          <p className="mt-2 text-xs text-muted">
            <Link href="/terms" className="hover:text-cream">Terms</Link> ·{' '}
            <Link href="/privacy" className="hover:text-cream">Privacy</Link> ·{' '}
            <Link href="/acceptable-use" className="hover:text-cream">Acceptable Use</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
