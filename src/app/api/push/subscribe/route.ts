/**
 * Register or remove this browser's web-push subscription for the signed-in user.
 *
 * The browser owns the subscription; we only keep a copy of it so the server
 * can address the device. `POST` upserts on the endpoint (a browser that
 * re-registers, or a device that changes hands between two accounts, ends up
 * with one row bound to whoever is signed in now); `DELETE` removes the
 * caller's row for that endpoint and nobody else's.
 *
 * Session is resolved through `currentUserId()`, which is the same identity on
 * both the Supabase-auth and local-auth builds. The service client is used for
 * the write so the row can be re-bound across users, which the self-only RLS
 * policy would refuse — and every query here is filtered by the resolved
 * `user_id`, never by anything the body claims.
 */
import { NextResponse } from 'next/server';
import { currentUserId } from '@/lib/auth/context';
import { createServiceClient } from '@/lib/supabase/server';
import { parsePushSubscription } from '@/lib/push';

export const runtime = 'nodejs';

/** Long enough to tell devices apart; a UA string is under 200 characters in practice. */
const MAX_USER_AGENT = 512;

const unauthorised = () => NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
const badRequest = () => NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return unauthorised();

  const sub = parsePushSubscription(await readJson(request));
  if (!sub) return badRequest();

  const userAgent = request.headers.get('user-agent')?.slice(0, MAX_USER_AGENT) ?? null;
  const sb = createServiceClient();
  const { error } = await sb
    .from('push_subscriptions')
    .upsert(
      { user_id: userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, user_agent: userAgent },
      { onConflict: 'endpoint' },
    );
  if (error) {
    console.error('[push] subscribe failed', error.message);
    return NextResponse.json({ error: 'Could not save this device.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const userId = await currentUserId();
  if (!userId) return unauthorised();

  const body = (await readJson(request)) as { endpoint?: unknown } | null;
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint || !isUrl(endpoint)) return badRequest();

  const sb = createServiceClient();
  const { error } = await sb.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', userId);
  if (error) {
    console.error('[push] unsubscribe failed', error.message);
    return NextResponse.json({ error: 'Could not remove this device.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
