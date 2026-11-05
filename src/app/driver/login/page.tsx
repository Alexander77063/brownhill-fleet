'use client';

// /driver/login — driver-specific signin. The driver is invited by ops at
// /ops/drivers; ops prints a /driver/login URL the driver uses. Same auth
// endpoint as the generic /login (PBKDF2 in auth.local_credentials, no
// magic-link off-SaaS). On success, hard-redirect to /driver — the driver
// portal's requireRole(['driver']) will accept only driver rows.
//
// This page is deliberately NOT under the driver portal's layout. That layout
// demands a session, so a signed-out driver used to be redirected away from
// this very page before it could render — the URL the operations app hands
// out was a dead end. The guarded pages live in `src/app/driver/(portal)/`
// instead; see tests/unit/signin-reachability.test.ts.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export default function DriverLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPwd, setShowPwd] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/local/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErr(data.error ?? 'Could not sign in.');
        return;
      }
      // Cookie set. Hand off to /driver.
      router.replace('/driver');
    } catch {
      setErr('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const labelCls = 'eyebrow text-parchment mb-1 block';
  const inputCls =
    'w-full rounded-[var(--radius)] border border-hair-soft bg-navy px-3 py-2.5 text-cream placeholder:text-muted focus:border-gold focus:outline-none';

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh grid place-items-center bg-navy px-6">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-[var(--radius)] border border-hair-soft bg-[rgba(255,255,255,0.03)] p-6"
      >
        <div className="mb-5">
          <Link href="/login" className="text-xs text-muted hover:text-cream">← back to sign-in options</Link>
        </div>
        <p className="eyebrow text-gold">Driver</p>
        <h1 className="mt-1 font-display text-3xl text-cream">Driver sign-in</h1>
        <p className="mt-2 text-sm text-muted">
          Use the email your operator invited you with.
        </p>

        <label className={labelCls} htmlFor="drv-email">Email</label>
        <input
          id="drv-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputCls}
        />

        <label htmlFor="drv-pw" className={`${labelCls} mt-4`}>Password</label>
        <div className="relative">
          <input
            id="drv-pw"
            type={showPwd ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${inputCls} pr-16`}
          />
          <button
            type="button"
            onClick={() => setShowPwd((s) => !s)}
            aria-pressed={showPwd}
            aria-label={showPwd ? 'Hide password' : 'Show password'}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-muted hover:text-gold-bright"
          >
            {showPwd ? 'Hide' : 'Show'}
          </button>
        </div>

        {err ? (
          <div
            role="alert"
            aria-live="assertive"
            className="mt-4 rounded-[var(--radius)] border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]"
          >
            {err === 'Those details do not match.' ? 'Email or password is wrong.' : err}
          </div>
        ) : null}

        <div className="mt-5">
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>

        {/* The recovery route, and this time it is a real one.
            This used to say "ask your dispatcher to reset it", and the link
            labelled "talk to your dispatcher" pointed at /login, which is not
            a dispatcher. Before that it linked "Forgot password?" to
            /driver/profile — a page behind the driver layout, so a driver who
            had forgotten their password was bounced straight back here, in a
            loop.
            Now the driver can do it themselves: the link goes to a page that
            is not behind this layout, and the reset link it sends arrives at
            the address on file.

            The link is UNDERLINED, not underlined-on-hover. It sits inside a
            sentence, so it is a link in a block of text, and WCAG 1.4.1
            (Use of Color) says a link in a block of text must be
            distinguishable without relying on colour — a colour that changes
            on hover is not available to somebody who cannot tell gold from
            grey, and an underline that appears on hover is not a distinction
            at all until the pointer is over it. axe calls this
            `link-in-text-block`, and it caught this page on 2026-11-04,
            when the accessibility suite was run against the hosted stack
            after this recovery route was added. */}
        <div className="mt-5 rounded-[var(--radius)] border border-hair-soft bg-[rgba(255,255,255,0.03)] p-3">
          <p className="text-sm text-parchment">Forgotten your password?</p>
          <p className="mt-1 text-xs text-muted">
            <Link href="/forgot-password?audience=driver" className="text-gold-bright underline">
              Reset it yourself
            </Link>{' '}
            — we will email a link to the address you were invited with. If the
            address has changed, ask your operator to update it.
          </p>
        </div>
      </form>
    </main>
  );
}
