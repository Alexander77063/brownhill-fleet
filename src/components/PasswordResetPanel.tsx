'use client';

// src/components/PasswordResetPanel — the operator's password reset.
//
// WHY THIS EXISTS
// ---------------
// A forgotten password had no recovery route inside the app. Both portal
// sign-in pages carried a "Forgot password?" link pointing at a page behind
// their own layout, so a locked-out user was bounced back to the sign-in form
// in a loop. The only thing that worked was `set-customer-password.mjs` on the
// customer's own box, over SSH.
//
// This panel is the working route: the dispatcher opens the driver's record
// and presses one button, and gets a temporary password to read out.
//
// The password is shown on screen, once, and is deliberately NOT stored
// anywhere in the app afterwards — if the operator loses it, they press the
// button again and a new one is issued. That is the same rule as a one-time
// link: what is displayed once and never written down is the safe shape for
// a secret that has to travel over the telephone.

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui';
import {
  resetMemberPasswordAction,
  type ResetPasswordResult,
} from '@/lib/actions/reset-password';

const initial: ResetPasswordResult = { ok: false };

export function PasswordResetPanel({
  userId,
  who,
  noAccount,
  intro,
}: {
  /** The auth user whose password is being reset. Null when they have none. */
  userId: string | null;
  /** Their name or email — used in the wording. */
  who: string;
  /** What to say when they have no sign-in account yet. */
  noAccount: string;
  /** What to say above the button. */
  intro?: string;
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ResetPasswordResult, fd: FormData) => resetMemberPasswordAction(fd),
    initial,
  );
  const [copied, setCopied] = useState(false);

  if (!userId) {
    return (
      <div>
        <p className="text-sm text-muted">{noAccount}</p>
      </div>
    );
  }

  async function copy() {
    if (!state.temporaryPassword) return;
    try {
      await navigator.clipboard?.writeText(state.temporaryPassword);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (an insecure origin, a denied
      // permission). The password is on screen and selectable either way.
      setCopied(false);
    }
  }

  return (
    <div>
      <p className="text-sm text-muted">
        {intro ??
          'Forgotten their password? Reset it here — they will get a temporary password to use until they change it.'}
      </p>

      <form action={formAction} className="mt-3">
        <input type="hidden" name="user_id" value={userId} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Resetting…' : 'Reset password'}
        </Button>
      </form>

      {state.error && !state.ok ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]"
        >
          {state.message ?? 'Could not reset the password.'}
        </p>
      ) : null}

      {state.ok && state.temporaryPassword ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 rounded-md border border-[var(--color-profit)] bg-[rgba(45,168,98,0.10)] px-3 py-2 text-sm"
        >
          <p className="font-medium text-[var(--color-profit)]">Password reset</p>
          <p className="mt-2 text-cream">Temporary password for {who}:</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {/* `min-w-0` lets the flex item shrink below its content width, and
                `break-all` lets the password wrap inside it. Without both, a
                32-character password is one unbreakable run wider than a
                phone, and the page scrolls sideways. */}
            <code className="min-w-0 select-all break-all rounded bg-[rgba(0,0,0,0.35)] px-2 py-1 font-mono text-cream">
              {state.temporaryPassword}
            </code>
            <Button type="button" variant="ghost" size="sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            {state.emailed
              ? 'Also emailed to them. It is shown here once — read it out if they are on the phone, and ask them to change it from their profile page as soon as they are in.'
              : 'Email is not sending on this deployment, so read it out now. It is shown here once — ask them to change it from their profile page as soon as they are in.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
