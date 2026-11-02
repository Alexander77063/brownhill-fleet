'use client';

// /ops/drivers/InviteDriverPanel — client wrapper that drives
// inviteDriverAction via useActionState so ops sees the resulting
// /driver/login URL + the driver's email after a successful invite.
//
// It also shows the temporary password, when the deployment issues one.
//
// WHY THE PASSWORD IS SHOWN HERE
// -----------------------------
//
// A self-hosted box signs its own sessions and normally has no email provider,
// so the welcome email goes nowhere — and the password used to live only in
// that email. The driver was left with an account nobody could sign in to, and
// the operator had no way to help them.
//
// So the password is shown on screen once, with a Copy button, exactly like
// the operator's own password reset does. It is not stored anywhere
// afterwards: after the operator has read it out, the only copy left is the
// driver's.

import { useActionState, useState } from 'react';
import { Button, CardTitle } from '@/components/ui';
import { HelpHint } from '@/components/HelpHint';
import {
  inviteDriverAction,
  type InviteDriverResult,
} from '@/lib/actions/driver-invite';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

const initial: InviteDriverResult = { ok: false };

export function InviteDriverPanel({ drivers }: { drivers: { id: string; full_name: string }[] }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: InviteDriverResult, fd: FormData) => inviteDriverAction(fd),
    initial,
  );
  const [copied, setCopied] = useState(false);

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
    <>
      <div className="flex items-center gap-2">
        <CardTitle>Invite a driver</CardTitle>
        <HelpHint id="drivers.invite" label="Invite a driver" />
      </div>
      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Name</span>
          <input type="text" name="full_name" className={inputCls} required />
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Login email</span>
          <input type="email" name="email" className={inputCls} required />
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Phone (optional)</span>
          <input type="tel" name="phone" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow text-parchment">Or link to existing</span>
          <select name="driver_id" className={inputCls}>
            <option value="">— new driver —</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.full_name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? 'Inviting…' : 'Invite driver'}
        </Button>
      </form>

      {state.error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]"
        >
          {state.message ?? 'Could not invite driver.'}
        </p>
      ) : state.ok && state.loginUrl ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-md border border-[var(--color-profit)] bg-[rgba(45,168,98,0.10)] px-3 py-2 text-sm"
        >
          <p className="text-[var(--color-profit)] font-medium">
            Driver invited{state.email ? ` · ${state.email}` : ''}
          </p>

          {state.temporaryPassword ? (
            <>
              <p className="mt-2 text-cream">Give them this temporary password:</p>
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
                It is shown here once — read it out to them, and ask them to change it from{' '}
                <code className="text-cream">/driver/profile</code> as soon as they are in.
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted">
              They already had an account, so no new password was issued. If they have forgotten theirs, reset
              it from their row in the members list.
            </p>
          )}

          <p className="mt-2 text-cream">Share this link with them so they can sign in:</p>
          <pre className="mt-1 select-all whitespace-pre-wrap break-all rounded bg-[rgba(0,0,0,0.35)] px-2 py-1 text-cream">
            {state.loginUrl}
          </pre>
          <p className="mt-2 text-xs text-muted">
            They&apos;ll land on the driver sign-in page. After the initial password, they should change it
            from <code className="text-cream">/driver/profile</code>.
          </p>
        </div>
      ) : null}
    </>
  );
}
