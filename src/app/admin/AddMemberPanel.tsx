'use client';

// src/app/admin/AddMemberPanel — the operator's add-a-team-member form.
//
// WHY THIS IS A PANEL AND NOT AN INLINE FORM
// ------------------------------------------
//
// The form used to post straight to a server action that threw on failure. A
// throw out of a server action takes the WHOLE page with it: the browser
// showed Next's error digest, the operator lost the form they were filling
// in, and nothing said whether the colleague had been added.
//
// So the action now returns a result and this panel shows it. Two things it
// has to be able to say:
//
//   1. WHAT WENT WRONG, in the page, next to the button.
//
//   2. THE TEMPORARY PASSWORD, when the deployment hands one out.
//
// The second one matters most on the customer's own box. That deployment signs
// its own sessions and normally has no email provider, so a password that was
// only ever emailed would reach nobody — the colleague would be added and
// then unable to sign in, and the operator would have no way to fix it. The
// password is shown on screen once, exactly like the operator's own password
// reset does, and is deliberately not stored anywhere afterwards.

import { useActionState, useEffect, useRef, useState } from 'react';
import { Button, CardTitle } from '@/components/ui';
import { groupPermissions } from '@/app/admin/permissions-catalog';
import { Field, inputCls } from '@/app/admin/Field';
import { addMemberAction, type AddMemberActionResult } from '@/lib/actions/admin';

const initial: AddMemberActionResult = { ok: false };

export function AddMemberPanel({ roles }: { roles: string[] }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: AddMemberActionResult, fd: FormData) => addMemberAction(fd),
    initial,
  );
  const [copied, setCopied] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // A member has been added, so the form is empty again — otherwise the same
  // address sits in the box, one button press away from being added twice.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

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
      <CardTitle>Add a member</CardTitle>
      <form ref={formRef} action={formAction} className="mt-3 space-y-3">
        <Field
          label="Email"
          hint="we'll create their login. On this deployment you are given a password to give them."
        >
          <input name="email" type="email" required placeholder="name@company.com" className={`${inputCls} w-full`} />
        </Field>
        <Field label="Role">
          <select name="role" defaultValue="ops" className={`${inputCls} w-full`}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Extra permissions"
          hint="On top of what the role grants — pick exactly what they need (e.g. an accountant gets billing.write + payments.record + reads)."
        >
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-hair-soft bg-[var(--surface-soft)] p-3">
            {groupPermissions().map((g) => (
              <fieldset key={g.group} className="rounded-md border border-hair-soft p-2">
                <legend className="px-1 text-[10px] font-semibold uppercase tracking-wider text-parchment">
                  {g.group}
                </legend>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {g.items.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-xs text-cream">
                      <input type="checkbox" name="permission" value={p.key} className="accent-[var(--color-gold)]" />
                      <span>{p.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </Field>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Adding…' : 'Add member'}
        </Button>
      </form>

      {state.ok ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 rounded-md border border-[var(--color-profit)] bg-[rgba(45,168,98,0.10)] px-3 py-2 text-sm"
        >
          <p className="font-medium text-[var(--color-profit)]">
            Member added{state.email ? ` · ${state.email}` : ''}
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
                It is shown here once — read it out to them, and ask them to change it from their profile page
                as soon as they are in.
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted">
              They already had an account, so no new password was issued. If they have forgotten theirs, reset
              it from their row in the members list below.
            </p>
          )}
        </div>
      ) : state.message ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-[var(--color-loss)] bg-[rgba(225,98,98,0.10)] px-3 py-2 text-sm text-[var(--color-loss)]"
        >
          {state.message}
        </p>
      ) : null}
    </>
  );
}
