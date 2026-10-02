'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';

/**
 * First-run setup for a self-hosted install.
 *
 * The very first thing a customer sees after the installer finishes. Nothing
 * exists yet — no account, no tenant — so this page creates both and signs
 * them straight in. It exists only in the standalone build; a hosted tenant is
 * onboarded through /admin instead.
 */
export default function SetupPage() {
  const [businessName, setBusinessName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // If an account already exists, this page must not offer to create another.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/local/setup')
      .then((r) => (r.ok ? r.json() : { needsSetup: false }))
      .then((d: { needsSetup?: boolean }) => {
        if (cancelled) return;
        if (!d.needsSetup) location.href = '/login';
        else setChecking(false);
      })
      .catch(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    if (password !== confirm) {
      setErr('The two passwords do not match.');
      return;
    }
    if (password.length < 12) {
      setErr('Use a password of at least 12 characters.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/local/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ businessName, fullName, email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Could not complete setup.');
      }
      // Already signed in by the cookie the endpoint set.
      location.href = '/';
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full rounded-lg border border-hair-soft bg-transparent px-3 py-2 text-cream outline-none focus:border-gold';

  if (checking) {
    return (
      <main id="main-content" tabIndex={-1} className="grid min-h-dvh place-items-center p-6">
        <p className="text-muted">Checking this installation…</p>
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-md">
        <p className="eyebrow">Welcome</p>
        <h1 className="mt-1 font-display text-3xl text-cream">Set up your system</h1>
        <div className="gold-rule mt-3 mb-4" />
        <p className="mb-6 text-sm text-muted">
          This runs entirely on this computer. Nothing is sent anywhere, and this account is the
          only way in — so keep the password somewhere safe.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="businessName" className="mb-1 block text-sm text-muted">
              Business name
            </label>
            <input
              id="businessName"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              required
              autoComplete="organization"
              className={inputCls}
              placeholder="Brownhill Group Limited"
            />
          </div>

          <div>
            <label htmlFor="fullName" className="mb-1 block text-sm text-muted">
              Your name
            </label>
            <input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="name"
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1 block text-sm text-muted">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm text-muted">
              Password
            </label>
            <div className="flex gap-2">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="shrink-0 rounded-lg border border-hair-soft px-3 text-sm text-muted hover:text-cream"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">At least 12 characters.</p>
          </div>

          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm text-muted">
              Confirm password
            </label>
            <input
              id="confirm"
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              className={inputCls}
            />
          </div>

          {err && (
            <p role="alert" className="text-sm text-red-400">
              {err}
            </p>
          )}

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Setting up…' : 'Create my account'}
          </Button>
        </form>
      </div>
    </main>
  );
}
