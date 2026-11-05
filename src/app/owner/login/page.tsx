'use client';

// /owner/login — vehicle-owner-specific signin. Same auth flow as the driver
// login; redirects to /owner on success.
//
// This page is deliberately NOT under the owner portal's layout, which demands
// a session — a sign-in page cannot live inside the tree that guards the
// pages behind it. The guarded pages live in `src/app/owner/(portal)/`
// instead; see tests/unit/signin-reachability.test.ts.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export default function OwnerLoginPage() {
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
      router.replace('/owner');
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
        <p className="eyebrow text-gold">Vehicle owner</p>
        <h1 className="mt-1 font-display text-3xl text-cream">Owner sign-in</h1>
        <p className="mt-2 text-sm text-muted">Sign in with the email on file.</p>

        <label className={labelCls} htmlFor="own-email">Email</label>
        <input
          id="own-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputCls}
        />

        <label htmlFor="own-pw" className={`${labelCls} mt-4`}>Password</label>
        <div className="relative">
          <input
            id="own-pw"
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

        <div className="mt-4">
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>

        {/* The recovery route, and this time it is a real one.
            This used to be a "Forgot password?" link to
            /owner/settings/security — a page behind the owner layout, so an
            owner who had forgotten their password was bounced straight back
            here, in a loop. Owners normally sign in with a code sent to their
            mobile number, so that route is still offered; and an owner who
            does use a password can now reset it themselves, without waiting
            for the operator.

            The links are UNDERLINED, not underlined-on-hover. They sit inside
            a sentence, so they are links in a block of text, and WCAG 1.4.1
            (Use of Color) says such a link must be distinguishable without
            relying on colour. This page is closed on the hosted profile, so
            the accessibility suite cannot scan it — the same defect on
            /driver/login WAS caught by that suite on 2026-11-04, and the
            fix is applied here too rather than waiting for the page to be
            scanned. */}
        <div className="mt-5 rounded-[var(--radius)] border border-hair-soft bg-[rgba(255,255,255,0.03)] p-3">
          <p className="text-sm text-parchment">Forgotten your password?</p>
          <p className="mt-1 text-xs text-muted">
            Vehicle owners normally sign in with a 6-digit code sent to your mobile number.{' '}
            <Link href="/login" className="text-gold-bright underline">
              Sign in with a code
            </Link>
            . If that number has changed, ask the fleet operator to update it. If you
            normally sign in with a password,{' '}
            <Link href="/forgot-password?audience=owner" className="text-gold-bright underline">
              reset it here
            </Link>{' '}
            and we will email a link to the address on file.
          </p>
        </div>
      </form>
    </main>
  );
}
