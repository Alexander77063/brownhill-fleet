/**
 * Redeem a reset token: set a new password.
 *
 * The decision half lives in `src/lib/auth/password-reset-token.ts`, which is
 * unit-tested without a database. This route supplies the real store and
 * turns the outcome into an answer.
 *
 * WHAT THE ANSWER MAY SAY
 * -----------------------
 * The reasons a redemption can be refused are: the request was malformed, the
 * two passwords did not match, the password was too short, the token was not
 * valid, the password is the one already in use, or the database could not be
 * reached. None of them says whether an ACCOUNT exists — an unknown token and
 * an expired token are both refused for the same reason, on purpose, so this
 * endpoint cannot be used to find out which tokens exist.
 *
 * It 404s under any other profile. Under `saas`, Supabase Auth owns password
 * recovery, and this product must not grow a second one that skips it.
 *
 * WHAT THE SUCCESSFUL ANSWER SAYS
 * -------------------------------
 * Two things, and both of them were missing on 2026-11-04:
 *
 *   * the AUDIT ROW. `docs/product/04-user-flow.md` says every reset is
 *     audited, and the operator's reset was — but the self-service reset
 *     changed a password and wrote nothing at all. The trail had no record of
 *     the one thing a person does to their own account that an administrator
 *     might have to answer for;
 *   * the DOOR. The redemption used to answer "ok" and nothing else, so the
 *     browser sent the person wherever the LINK had said — which could be half
 *     an hour out of date, and on a build with no vehicle-owner portal, a page
 *     that build does not serve.
 *
 * So the answer carries the door, worked out from the account's role read at
 * the REDEMPTION, and the row is filed under the tenant the account belongs
 * to.
 */
import { NextResponse } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { completePasswordReset } from '@/lib/auth/password-reset-token';
import { localResetTokenStore } from '@/lib/auth/password-reset-local-store';
import { auditPasswordReset } from '@/lib/auth/password-reset-audit';
import {
  RESET_SIGN_IN_PATHS,
  resetAudienceOnBuild,
} from '@/lib/auth/password-reset-policy';
import { appendAudit, type AuditClient } from '@/lib/audit';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const profile = deploymentProfile();
  if (profile.supabaseAuth) {
    return new NextResponse('Not found', { status: 404 });
  }

  let token = '';
  let password = '';
  let confirm = '';
  try {
    const body = (await request.json()) as {
      token?: unknown;
      password?: unknown;
      confirm?: unknown;
    };
    token = typeof body.token === 'string' ? body.token : '';
    password = typeof body.password === 'string' ? body.password : '';
    confirm = typeof body.confirm === 'string' ? body.confirm : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  let outcome: Awaited<ReturnType<typeof completePasswordReset>>;
  try {
    outcome = await completePasswordReset({
      token,
      password,
      confirm,
      store: await localResetTokenStore(),
    });
  } catch (e) {
    console.error('[auth] the password reset could not be completed', e);
    return NextResponse.json(
      { error: 'Could not change the password. Nothing has changed — try again.' },
      { status: 503 },
    );
  }

  if (!outcome.ok) {
    // A failure to reach the database is a fault on our side; everything else
    // is the person's request, and 400 is the honest answer for those.
    const status = outcome.reason === 'failed' ? 503 : 400;
    return NextResponse.json(
      { error: outcome.message, reason: outcome.reason },
      { status },
    );
  }

  // The DOOR. The account's role, read at the redemption rather than taken
  // from the link — the link can be half an hour old, and the role can have
  // changed in that time. The rule that works it out is the SAME one the
  // email and the reset page use, and it takes the build as an argument: an
  // owner signs in at the owner portal, but only on a build that HAS one.
  const audience = resetAudienceOnBuild(outcome.account.role, profile.ownerPortal);

  // The AUDIT ROW. The password has already been changed by this point, so
  // nothing in here may turn that into an error the person sees — the module
  // reports a failed write and carries on.
  //
  // The audit client is opened lazily, inside the write. A build with no
  // signing secret is a broken install, and that must not become a 500 on a
  // password that has already been changed.
  let sb: AuditClient | null = null;
  await auditPasswordReset({
    account: {
      userId: outcome.userId,
      role: outcome.account.role,
      tenantIds: outcome.account.tenantIds,
    },
    write: async (row) => {
      if (sb === null) {
        sb = createServiceClient();
      }
      await appendAudit(sb, row);
    },
  });

  return NextResponse.json({
    ok: true,
    audience,
    signInUrl: RESET_SIGN_IN_PATHS[audience],
  });
}
