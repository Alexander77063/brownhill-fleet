'use client';

// Choose a new password, using the token from the reset link.
//
// THE TOKEN
// ---------
// The link carries the token in its URL FRAGMENT — the part after the `#`.
// The browser does not send a fragment to the server: not in the request, not
// in a referrer, not in a log. So the token is read here, in the browser, and
// posted in the BODY of the redemption, and it is taken out of the address
// bar before anything else happens.
//
// The link used to carry the token in the query string, where everything
// copies a secret into: the browser's history, the address bar, every log
// that records the request line, and the `Referer` of the next request the
// page makes. It was good for half an hour, and anybody who could read any of
// those could spend it.
//
// WHAT THE BROWSER IS TOLD
// ------------------------
// An unknown token and an expired token are refused for the SAME reason. If
// they were different, this page would be a way to find out which tokens
// exist — and which tokens exist is worth knowing to somebody trying to take
// an account over. So a link with no token in it gets the same answer a
// spent one gets.
//
// The password never leaves the browser in the clear except to this
// deployment's own endpoint, which is the only place that can turn it into a
// stored credential.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui';
import {
  MIN_RESET_PASSWORD_LENGTH,
  RESET_SIGN_IN_PATHS,
  resetSignInPath,
  resetTokenFromFragment,
  type ResetAudience,
} from '@/lib/auth/password-reset-policy';

const labelCls = 'eyebrow text-parchment mb-1 block';
const inputCls =
  'w-full rounded-[var(--radius)] border border-hair-soft bg-navy px-3 py-2.5 text-cream placeholder:text-muted focus:border-gold focus:outline-none';

export function ResetPasswordForm({
  audience,
}: {
  /** Which door this person signs in at. */
  audience: ResetAudience;
}) {
  // The token, once it has been read out of the fragment.
  //
  // `null` means "not read yet": the page is rendered on the server before
  // the browser has looked at the fragment, and a form with no token in it is
  // a form that cannot work. `''` means the fragment held no token, which is
  // the same answer as a token that has expired — a link that never existed
  // and a link that is too old are refused alike, so the page cannot be used
  // to find out which tokens exist.
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Where the person is sent once the password has changed.
  //
  // The link's audience is the guess; the SERVER's answer is the truth. It
  // read the account's role at the moment the password was changed, and the
  // link can be half an hour out of date. So the answer replaces the guess
  // the moment there is one — and until then the guess is all there is.
  const [signInPath, setSignInPath] = useState(RESET_SIGN_IN_PATHS[audience]);

  // Whether the fragment has already been read.
  //
  // React runs an effect twice on the first mount in development, and the
  // second run would find an EMPTY fragment — the first run took the token
  // out of the URL — and would throw the token away. So the fragment is read
  // once and once only, and the token is remembered here.
  const read = useRef(false);

  useEffect(() => {
    if (read.current) return;
    read.current = true;

    const found = resetTokenFromFragment(window.location.hash);

    // Take the token out of the address bar. `replaceState` rewrites the
    // CURRENT history entry, so the token is not left behind for the Back
    // button, and it is not in the URL that gets copied out of here. The
    // query string stays: it names the door, which is not a secret.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    setToken(found);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    // There is no token to redeem. The form is not rendered in that case,
    // so this is a guard rather than a path — and a guard that names the
    // answer rather than posting an empty token.
    if (!token) {
      setErr('That reset link is not valid. Ask for a new one.');
      return;
    }

    // The same two rules the server enforces, checked here so the person is
    // told before the round trip rather than after it.
    if (password.length < MIN_RESET_PASSWORD_LENGTH) {
      setErr(`A password must be at least ${MIN_RESET_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setErr('The two passwords do not match. Type them again.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/local/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password, confirm }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        audience?: unknown;
      };
      if (!res.ok || !data.ok) {
        setErr(data.error ?? 'Could not change the password. Nothing has changed — try again.');
        return;
      }
      // The door the server chose. Only one of the three known doors, never a
      // path from the response.
      setSignInPath(resetSignInPath(data.audience, audience));
      setDone(true);
    } catch {
      setErr('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh grid place-items-center bg-navy px-6">
      <div className="w-full max-w-md rounded-[var(--radius)] border border-hair-soft bg-[rgba(255,255,255,0.03)] p-6">
        {token === null ? (
          // The fragment has not been read yet. It is read the moment the
          // browser is ready, and the page has to say something in the
          // meantime — a page with no heading is a page the accessibility
          // scan cannot make sense of.
          <>
            <p className="eyebrow text-gold">Account</p>
            <h1 className="mt-1 font-display text-3xl text-cream">Opening your link</h1>
            <p role="status" aria-live="polite" className="mt-2 text-sm text-muted">
              One moment.
            </p>
          </>
        ) : token === '' ? (
          // No token in the link. The same answer a spent or expired link
          // gets, because a link that never existed and a link that is too
          // old must not be told apart.
          <>
            <p className="eyebrow text-gold">Account</p>
            <h1 className="mt-1 font-display text-3xl text-cream">That reset link is not valid</h1>
            <div role="status" aria-live="polite">
              <p className="mt-2 text-sm text-muted">
                It may have expired, or it may already have been used. Ask for a new one and it
                will arrive in a few minutes.
              </p>
            </div>
            <div className="mt-5">
              <Link
                href="/forgot-password"
                className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] bg-gradient-to-b from-gold-bright to-gold px-4 py-2.5 text-sm font-semibold text-on-gold"
              >
                Ask for a new link
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="mb-5">
              <Link href="/forgot-password" className="text-xs text-muted hover:text-cream">
                ← ask for another link
              </Link>
            </div>
            <p className="eyebrow text-gold">Account</p>
            <h1 className="mt-1 font-display text-3xl text-cream">Choose a new password</h1>
            <p className="mt-2 text-sm text-muted">
              Pick something you have not used here before. It has to be at least{' '}
              {MIN_RESET_PASSWORD_LENGTH} characters.
            </p>

            {done ? (
              <>
                <div
                  role="status"
                  aria-live="polite"
                  className="mt-5 rounded-[var(--radius)] border border-[var(--color-profit)] bg-[rgba(45,168,98,0.12)] px-3 py-3 text-sm text-[var(--color-profit)]"
                >
                  Your password has been changed. Sign in with it now.
                </div>
                <div className="mt-5">
                  <Button href={signInPath} className="w-full">
                    Go to sign-in
                  </Button>
                </div>
              </>
            ) : (
              <form onSubmit={submit} className="mt-5">
                <label className={labelCls} htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type="password"
                  required
                  minLength={MIN_RESET_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />

                <label className={`${labelCls} mt-4`} htmlFor="confirm-password">Confirm new password</label>
                <input
                  id="confirm-password"
                  type="password"
                  required
                  minLength={MIN_RESET_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
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
                    {busy ? 'Saving…' : 'Set the new password'}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}
