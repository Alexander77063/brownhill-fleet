'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { deploymentBrand } from '@/lib/deployment/brand';
import { safeNextPath } from '@/lib/safe-next';

/** What this build is called and may say about itself. Constant per build. */
const BRAND = deploymentBrand();

type Mode = 'email' | 'phone' | 'password';

/**
 * Which sign-in methods this build can honour.
 *
 * Only the SaaS has Supabase Auth, so only it offers the email link. Every
 * other build signs in against its own database: password for staff, and — on
 * the builds that have vehicle owners — a text-message code for people who
 * have a phone and not necessarily an email. A self-hosted install is staff
 * only, so it is password only. Offering a button that cannot work is worse
 * than not offering it.
 */
const PROFILE = process.env.NEXT_PUBLIC_DEPLOYMENT_PROFILE ?? 'saas';
const LOCAL_AUTH = PROFILE !== 'saas';
const STANDALONE = PROFILE === 'standalone';
const MODES: Mode[] = STANDALONE ? ['password'] : LOCAL_AUTH ? ['phone', 'password'] : ['email', 'password', 'phone'];
const DEFAULT_MODE: Mode = STANDALONE ? 'password' : LOCAL_AUTH ? 'phone' : 'email';

async function postJson(url: string, body: unknown): Promise<{ next?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; next?: string };
  if (!res.ok) throw new Error(data.error ?? 'Could not sign in.');
  return data;
}

/** Where to go after sign-in: a same-origin `?next=` (an SMS report link), else home. */
function nextPath(): string {
  return safeNextPath(new URLSearchParams(location.search).get('next'));
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);

  // A freshly installed self-hosted system has no accounts at all. Showing a
  // sign-in form there is a dead end — there are no credentials to enter and no
  // dashboard anywhere to create some — so send them to first-run setup.
  useEffect(() => {
    if (!STANDALONE) return;
    let cancelled = false;
    fetch('/api/auth/local/setup')
      .then((r) => (r.ok ? r.json() : { needsSetup: false }))
      .then((d: { needsSetup?: boolean }) => {
        if (!cancelled && d.needsSetup) location.href = '/setup';
      })
      .catch(() => {
        /* the database may still be starting; the form remains usable */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [value, setValue] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'request' | 'verify' | 'sent'>('request');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      // Local auth: our own endpoints verify against the local database and
      // set the session cookie PostgREST will verify.
      if (LOCAL_AUTH && mode === 'password') {
        await postJson('/api/auth/local/signin', { email: value, password });
        // Staff arriving from an emergency link land on the request, not the dashboard.
        location.href = nextPath();
        return;
      }
      if (LOCAL_AUTH && mode === 'phone') {
        await postJson('/api/auth/local/otp/request', { phone: value });
        setStage('verify');
        setMsg('We sent a 6-digit code to your phone.');
        return;
      }

      const supabase = createClient(); // lazily — never during SSR/prerender
      if (mode === 'password') {
        const { error } = await supabase.auth.signInWithPassword({ email: value, password });
        if (error) throw error;
        location.href = '/';
        return;
      } else if (mode === 'email') {
        const { error } = await supabase.auth.signInWithOtp({
          email: value,
          options: { emailRedirectTo: `${location.origin}/auth/confirm` },
        });
        if (error) throw error;
        setStage('sent');
        setMsg('Check your email for a secure sign-in link.');
      } else {
        const { error } = await supabase.auth.signInWithOtp({ phone: value });
        if (error) throw error;
        setStage('verify');
        setMsg('We sent a 6-digit code to your phone.');
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (LOCAL_AUTH) {
        const r = await postJson('/api/auth/local/otp/verify', { phone: value, code: otp, next: nextPath() });
        location.href = safeNextPath(r.next);
        return;
      }
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({ phone: value, token: otp, type: 'sms' });
      if (error) throw error;
      location.href = '/';
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Invalid code.');
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
            <p className="font-display text-xl text-cream">{BRAND.productName}</p>
            <p className="eyebrow">{BRAND.kicker}</p>
          </div>
        </div>
        <div className="relative z-10 max-w-md">
          <div className="gold-rule mb-5" />
          {/* Not the page's heading: this panel is `hidden lg:flex`, so making it the
              <h1> left every mobile viewport with no h1 at all. The real heading is
              "Welcome back" in the form panel below. */}
          <p className="font-display text-4xl leading-tight text-cream">{BRAND.headline}</p>
          <p className="mt-4 text-sm text-muted">{BRAND.blurb}</p>
        </div>
        <p className="relative z-10 text-xs text-muted">{BRAND.footnote}</p>
      </section>

      {/* Form panel */}
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" className="h-10 w-10" />
            <p className="font-display text-lg text-cream">{BRAND.productName}</p>
          </div>

          <p className="eyebrow">Sign in</p>
          <h1 className="mt-1 font-display text-3xl text-cream">Welcome back</h1>
          <div className="gold-rule mt-3 mb-6" />

          {/* Sign-in method chooser. `aria-pressed` is what tells a screen-reader user
              which method is currently selected — the styling alone does not. */}
          <div
            className={cn(
              'mb-5 inline-flex rounded-full border border-hair-soft p-1 text-sm',
              // With one method there is nothing to choose between.
              MODES.length < 2 && 'hidden',
            )}
          >
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  setMode(m);
                  setStage('request');
                  setMsg(null);
                  setErr(null);
                }}
                className={cn(
                  'rounded-full px-3 py-1.5 font-medium transition',
                  mode === m ? 'bg-gold text-on-gold' : 'text-muted hover:text-cream',
                )}
              >
                {m === 'email' ? 'Email link' : m === 'password' ? 'Password' : 'Phone code'}
              </button>
            ))}
          </div>

          {stage !== 'verify' ? (
            <form onSubmit={requestCode} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs text-parchment">
                  {mode === 'phone' ? 'Mobile number' : 'Email address'}
                </span>
                <input
                  type={mode === 'phone' ? 'tel' : 'email'}
                  required
                  autoComplete={mode === 'phone' ? 'tel' : 'email'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={mode === 'phone' ? BRAND.phonePlaceholder : BRAND.emailPlaceholder}
                  className="w-full rounded-[var(--radius)] border border-hair-soft bg-navy px-3 py-2.5 text-cream placeholder:text-muted focus:border-gold"
                />
              </label>
              {mode === 'password' && (
                /* Explicit htmlFor/id rather than wrapping: the show/hide toggle sits in
                   the same box, and an implicit <label> around both made the input's
                   accessible name "Password Show" instead of "Password" (WCAG 4.1.2).
                   Caught by the runtime axe/Playwright pass, not by static analysis. */
                <div className="block">
                  <label htmlFor="login-password" className="mb-1 block text-xs text-parchment">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-[var(--radius)] border border-hair-soft bg-navy px-3 py-2.5 pr-16 text-cream placeholder:text-muted focus:border-gold"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-pressed={showPassword}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-muted hover:text-gold-bright"
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              )}
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? 'Signing in…' : mode === 'email' ? 'Send magic link' : mode === 'password' ? 'Sign in' : 'Send code'}
              </Button>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs text-parchment">6-digit code</span>
                <input
                  inputMode="numeric"
                  maxLength={6}
                  required
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="••••••"
                  className="w-full rounded-[var(--radius)] border border-hair-soft bg-navy px-3 py-2.5 text-center text-2xl tracking-[0.5em] text-cream focus:border-gold"
                />
              </label>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? 'Verifying…' : 'Verify & sign in'}
              </Button>
            </form>
          )}

          {/* Live regions: without these the outcome of a sign-in attempt is silent to
              screen-reader users, because focus never moves (WCAG 4.1.3 Status Messages).
              The wrappers are always rendered so assistive tech observes the mutation. */}
          <div role="status" aria-live="polite" className="mt-4 text-sm text-[var(--color-profit)]">
            {msg}
          </div>
          <div role="alert" aria-live="assertive" className="mt-1 text-sm text-[var(--color-loss)]">
            {err}
          </div>

          <p className="mt-8 text-xs text-muted">
            {LOCAL_AUTH && !STANDALONE
              ? 'Vehicle owners sign in with their mobile number. Staff sign in with a password.'
              : 'Access is by invitation. Contact your fleet administrator if you cannot sign in.'}
          </p>
          {/* Self-serve signup: on the SaaS it is the request-access form; on
              the shared Nigerian instance it is the phone code itself — an
              unknown number becomes a new account. Off both, there is nothing
              to offer, and a link to /request-access would 404. */}
          {BRAND.showRequestAccess && LOCAL_AUTH && (
            <p className="mt-2 text-xs text-muted">
              New here? Enter your mobile number above — we&apos;ll text you a code and set you up.
            </p>
          )}
          {BRAND.showRequestAccess && !LOCAL_AUTH && (
            <p className="mt-2 text-xs text-muted">
              New to {BRAND.productName}?{' '}
              <Link href="/request-access" className="text-gold-bright hover:underline">
                Request access
              </Link>
            </p>
          )}
          <p className="mt-4 text-xs text-muted">
            <Link href="/terms" className="hover:text-cream">Terms</Link> ·{' '}
            <Link href="/privacy" className="hover:text-cream">Privacy</Link> ·{' '}
            <Link href="/acceptable-use" className="hover:text-cream">Acceptable Use</Link> ·{' '}
            <Link href="/accessibility" className="hover:text-cream">Accessibility</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
