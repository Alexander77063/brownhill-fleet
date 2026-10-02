import { NextResponse } from 'next/server';
import { isPlatformAdmin, currentUserId } from '@/lib/auth/context';
import { acknowledgeRequest } from '@/lib/requests';

// The link in the push / SMS: one tap by a signed-in platform admin stops the
// ladder and lands them on the request. Anyone else is sent to sign in.
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const userId = await currentUserId();
  if (!userId || !(await isPlatformAdmin())) {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname)}`, url.origin));
  }
  await acknowledgeRequest(id, userId);
  return NextResponse.redirect(new URL(`/platform/assistance/${id}`, url.origin));
}
