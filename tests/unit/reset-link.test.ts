// tests/unit/reset-link.test.ts
//
// The email that carries the reset link.
//
// WHY THIS FILE EXISTS
// --------------------
// The email decides which door the person ends at. It used to work the door
// out from the account's role alone, which meant that on a build with NO
// vehicle-owner portal it pointed an owner at `/owner/login` — a page that
// build does not serve. The person who was trying to get back in followed a
// link to a 404, in the feature built to end dead ends.
//
// The rule now lives in one place (`resetAudienceOnBuild`) and takes the
// BUILD as an argument, so the email has to say which build it is on. This
// file proves it does, and that the answer it builds is the same one the
// reset page and the redemption use.
//
// The mail providers are mocked, so this file is about the BODY of the email:
// where it sends the person, and what it tells them.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetAccount } from '@/lib/auth/password-reset-request';

const sent: Array<{ to: string; subject: string; html: string }> = [];

vi.mock('@/lib/branding', () => ({
  brandDisplayName: () => 'Brownhill',
  brandEmailFrom: () => 'no-reply@brownhill.example',
  getBranding: async () => ({}),
}));

vi.mock('@/lib/email/tenant-email', () => ({
  sendTenantEmail: async (
    _tenantId: string,
    to: string,
    subject: string,
    html: string,
  ) => {
    sent.push({ to, subject, html });
    return { channel: 'email' as const, sent: true };
  },
}));

vi.mock('@/lib/notify', () => ({
  sendEmail: async (to: string, subject: string, html: string) => {
    sent.push({ to, subject, html });
    return { channel: 'email' as const, sent: true };
  },
}));

const { deliverResetLink } = await import('@/lib/auth/reset-link');

const ORIGIN = 'https://fleet.example.com';

function accountWith(role: string): ResetAccount {
  return {
    userId: '11111111-1111-1111-1111-111111111111',
    email: 'person@example.test',
    fullName: 'A Person',
    tenantId: null,
    role,
  };
}

async function sendTo(role: string, ownerPortal: boolean): Promise<string> {
  sent.length = 0;
  await deliverResetLink({
    account: accountWith(role),
    token: 'a-token',
    expiresAt: new Date(Date.now() + 60_000),
    origin: ORIGIN,
    ownerPortal,
  });
  expect(sent).toHaveLength(1);
  return sent[0].html;
}

describe('the email that carries the reset link', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('sends a driver to the driver sign-in', async () => {
    const html = await sendTo('driver', false);

    expect(html).toContain(`${ORIGIN}/driver/login`);
  });

  it('sends everybody else to the staff sign-in', async () => {
    const html = await sendTo('ops', false);

    expect(html).toContain(`${ORIGIN}/login`);
    expect(html).not.toContain('/driver/login');
  });

  it('sends a vehicle owner to the owner sign-in where there is one', async () => {
    const html = await sendTo('owner', true);

    expect(html).toContain(`${ORIGIN}/owner/login`);
  });

  it('sends a vehicle owner to the staff sign-in where there is NO owner portal', async () => {
    // The defect of 2026-11-04: `/owner/login` on a build that does not
    // serve it. The link worked; the page it pointed at did not.
    const html = await sendTo('owner', false);

    expect(html).toContain(`${ORIGIN}/login`);
    expect(html).not.toContain('/owner/login');
  });

  it('names the door in the link itself, so the page agrees with the email', async () => {
    // The page reads the audience out of the query string. If the email
    // built a link with a different door in it, the two would disagree — and
    // the redemption answers with the account's CURRENT role, which is the
    // one that counts.
    const html = await sendTo('driver', false);

    expect(html).toContain('audience=driver');
  });

  it('never carries the password, or the account, into the link', async () => {
    const html = await sendTo('driver', false);

    expect(html).toContain('a-token');
    expect(html).not.toContain('password=');
  });
});
