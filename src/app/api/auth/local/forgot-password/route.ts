/**
 * Ask for a password reset link.
 *
 * WHY THIS EXISTS
 * ---------------
 * A driver or an owner who forgot their password had exactly one route back
 * in: phone the office, and the office logged in to the operations app and
 * pressed "Reset password" on their record. That is a recovery path for the
 * OFFICE, not for the person. On a box that is not staffed around the clock
 * it means a driver cannot start a shift, and the complaint lands on the
 * office before it lands on the software.
 *
 * The link goes to the address ON FILE, once, and expires in half an hour.
 *
 * WHAT THIS ROUTE IS
 * ------------------
 * An adapter. It turns a request into the arguments the handler wants, and
 * the handler's answer into a response. Every decision — what the answer
 * is, when it is given, what is allowed to go out — is in
 * `src/lib/auth/forgot-password.ts`, where it is tested without a
 * framework.
 *
 * THE ONE ANSWER
 * --------------
 * Every caller gets the same response, whatever the address turns out to
 * be. "We sent you a link" and "no such account" must not be different
 * answers: if they were, this endpoint would be a way to find out who has
 * an account with this operator, and the person most likely to run that is
 * exactly the person trying to take one over.
 *
 * That is also why the throttle below is SILENT. A 429 on one address and a
 * 200 on another would be the same oracle wearing a different hat.
 *
 * AND WHY IT IS FAST
 * ------------------
 * The answer comes back before the application knows whether the address is
 * on file. The account lookup, the token, the email and the audit all
 * happen after the response has gone out — because a response that takes
 * longer for the addresses that exist is a response that says which
 * addresses exist.
 *
 * It 404s under any other profile. Under `saas`, Supabase Auth owns password
 * recovery, and this product must not grow a second one that skips it.
 */
import { NextResponse, after } from 'next/server';
import { deploymentProfile } from '@/lib/deployment/profile';
import { clientIpFrom } from '@/lib/auth/client-ip';
import { configuredResetOrigin, handleForgotPassword } from '@/lib/auth/forgot-password';
import {
  localResetRequestStore,
  localResetThrottleStore,
} from '@/lib/auth/password-reset-local-store';
import { deliverResetLink } from '@/lib/auth/reset-link';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const profile = deploymentProfile();
  if (profile.supabaseAuth) {
    return new NextResponse('Not found', { status: 404 });
  }

  let email = '';
  try {
    const body = (await request.json()) as { email?: unknown };
    email = typeof body.email === 'string' ? body.email : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // The origin is the DEPLOYMENT's address and never the request's. The
  // handler refuses to issue a link without one.
  const origin = configuredResetOrigin();

  // The caller's address, from the header nginx overwrites — not from the
  // one the caller wrote.
  const clientIp = clientIpFrom(request.headers);

  const outcome = await handleForgotPassword({
    email,
    origin,
    clientIp,
    store: await localResetRequestStore(),
    throttle: await localResetThrottleStore(),
    // The origin is only ever used once the handler has decided to send,
    // and it only sends when there is one.
    deliver: origin
      ? (args) => deliverResetLink({ ...args, origin, ownerPortal: profile.ownerPortal })
      : async () => ({ sent: false, reason: 'this deployment has no configured address' }),
    // The framework's "after the response": the account work happens once
    // the person has their answer.
    schedule: (work) => {
      after(work);
    },
  });

  if (outcome.status === 200) {
    return NextResponse.json(outcome.body);
  }
  return NextResponse.json(outcome.body, { status: outcome.status });
}
