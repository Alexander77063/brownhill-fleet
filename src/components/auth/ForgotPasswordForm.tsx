'use client';

// The "ask for a reset link" form, shared by every console.
//
// WHY THIS EXISTS
// ---------------
// A driver who forgot their password had exactly one route back in: phone the
// office, and the office logged in to the operations app and pressed "Reset
// password" on their record. That is a recovery path for the OFFICE, not for
// the person — and on a box that is not staffed around the clock it means a
// driver cannot start a shift.
//
// WHAT THE BROWSER IS TOLD
// ------------------------
// The SAME sentence, whatever the address turns out to be. "We sent you a
// link" and "no such account" must not be different answers: if they were,
// this page would be a way to find out who has an account with this operator,
// and the person most likely to run that is exactly the person trying to take
// one over.
//
// So the form does not know whether the address is real, and neither does the
// person reading it. The message says "if that address has an account".

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui';
import {
  RESET_REQUEST_MESSAGE,
  type ResetAudience,
} from '@/lib/auth/password-reset-policy';

interface AudienceCopy {
  /** The little label above the heading. */
  eyebrow: string;
  /** The heading. */
  title: string;
  /** The sentence that says what happens next. */
  intro: string;
  /** Where the "back" link goes — the sign-in page this person uses. */
  backTo: string;
  /** What the "back" link says. */
  backLabel: string;
}

const COPY: Record<ResetAudience, AudienceCopy> = {
  staff: {
    eyebrow: 'Account',
    title: 'Reset your password',
    intro:
      'Enter the email address on your account. If it has one, we will send a link to choose a new password.',
    backTo: '/login',
    backLabel: '← back to sign-in',
  },
  driver: {
    eyebrow: 'Driver',
    title: 'Reset your password',
    intro:
      'Enter the email your operator invited you with. If it has one, we will send a link to choose a new password.',
    backTo: '/driver/login',
    backLabel: '← back to driver sign-in',
  },
  owner: {
    eyebrow: 'Vehicle owner',
    title: 'Reset your password',
    intro:
      'Enter the email address on file. If it has one, we will send a link to choose a new password.',
    backTo: '/owner/login',
    backLabel: '← back to owner sign-in',
  },
};

const labelCls = 'eyebrow text-parchment mb-1 block';
const inputCls =
  'w-full rounded-[var(--radius)] border border-hair-soft bg-navy px-3 py-2.5 text-cream placeholder:text-muted focus:border-gold focus:outline-none';

export function ForgotPasswordForm({ audience }: { audience: ResetAudience }) {
  const copy = COPY[audience];
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setSent(null);
    try {
      const res = await fetch('/api/auth/local/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        // A fault on our side — the database, or the mail provider. Saying so
        // saves somebody trying their password ten times.
        setErr(data.error ?? 'Could not start the reset. Please try again in a moment.');
        return;
      }
      // The neutral sentence, whatever happened behind the scenes.
      setSent(data.message ?? RESET_REQUEST_MESSAGE);
    } catch {
      setErr('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh grid place-items-center bg-navy px-6">
      <div className="w-full max-w-md rounded-[var(--radius)] border border-hair-soft bg-[rgba(255,255,255,0.03)] p-6">
        <div className="mb-5">
          <Link href={copy.backTo} className="text-xs text-muted hover:text-cream">
            {copy.backLabel}
          </Link>
        </div>
        <p className="eyebrow text-gold">{copy.eyebrow}</p>
        <h1 className="mt-1 font-display text-3xl text-cream">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted">{copy.intro}</p>

        {sent ? (
          <>
            {/* The outcome is announced even though focus has not moved. */}
            <div
              role="status"
              aria-live="polite"
              className="mt-5 rounded-[var(--radius)] border border-hair-soft bg-[rgba(255,255,255,0.03)] px-3 py-3 text-sm text-parchment"
            >
              {sent}
            </div>
            <p className="mt-3 text-xs text-muted">
              The link goes to the address on file, so check that inbox — including
              the junk folder.{' '}
              <Link href={copy.backTo} className="text-gold-bright hover:underline">
                Back to sign-in
              </Link>
              .
            </p>
          </>
        ) : (
          <form onSubmit={submit} className="mt-5">
            <label className={labelCls} htmlFor="reset-email">Email address</label>
            <input
              id="reset-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={inputCls}
            />

            {err ? (
              <div
                role="alert"
                aria-live="assertive"
                className="mt-4 rounded-[var(--radius)] border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]"
              >
                {err}
              </div>
            ) : null}

            <div className="mt-5">
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? 'Sending…' : 'Send the reset link'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
