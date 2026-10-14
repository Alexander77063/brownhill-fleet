'use client';

// Shared <ChangePasswordForm> used by every role's profile page. Use with
// the same wiring as /app/driver/insurance/CertUploadForm — a top-level
// <ServerAction> prop passed in from the page, plus an `action` that the
// server action is bound to via .bind(null, null).

import { useActionState } from 'react';
import { Button } from '@/components/ui';
import {
  changeOwnPasswordAction,
  type ChangePasswordResult,
} from '@/lib/actions/change-password';

const initial: ChangePasswordResult | null = null;

const fieldCls =
  'mt-1 w-full rounded-[var(--radius)] border border-hair-soft bg-[rgba(0,0,0,0.25)] px-3 py-2.5 text-sm text-cream placeholder:text-muted focus:border-[var(--color-gold)] focus:outline-none';
const labelCls = 'eyebrow text-parchment';

const ERROR_TEXT: Record<NonNullable<ChangePasswordResult['error']>, string> = {
  unauthenticated: 'Your session has expired. Sign in again to change your password.',
  new_password_too_short: 'Use a password of at least {{min}} characters.',
  mismatch: 'New password and confirmation do not match.',
  must_differ: 'New password must be different from the current one.',
  current_password_incorrect: 'Current password is wrong.',
  session_mismatch: 'Session mismatch — sign out and back in, then try again.',
  unknown: 'Could not change password. Try again or contact support.',
};

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ChangePasswordResult | null, fd: FormData) =>
      changeOwnPasswordAction(fd),
    initial,
  );

  const ok = state?.ok === true;
  const errMsg = state && !state.ok && state.error
    ? (ERROR_TEXT[state.error] ?? ERROR_TEXT.unknown).replace('{{min}}', String(state.min ?? 12))
    : null;

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className={labelCls} htmlFor="pw-current">Current password</label>
        <input
          id="pw-current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
          className={fieldCls}
        />
      </div>

      <div>
        <label className={labelCls} htmlFor="pw-new">New password</label>
        <input
          id="pw-new"
          name="new"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          className={fieldCls}
        />
        <p className="mt-1 text-xs text-muted">12 characters or more. Mix any types — length is what matters.</p>
      </div>

      <div>
        <label className={labelCls} htmlFor="pw-confirm">Confirm new password</label>
        <input
          id="pw-confirm"
          name="confirm"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          className={fieldCls}
        />
      </div>

      {ok ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-[var(--radius)] border border-[var(--color-profit)] bg-[rgba(45,168,98,0.12)] px-3 py-2 text-sm text-[var(--color-profit)]"
        >
          Password updated. Sign in again on your other devices.
        </div>
      ) : errMsg ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-[var(--radius)] border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]"
        >
          {errMsg}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Updating…' : 'Update password'}
        </Button>
      </div>
    </form>
  );
}
