// tests/unit/serviceable-guard.test.ts
//
// THE PAY-FIRST GUARD: "nothing works until money is received".
//
// WHAT THE GUARD IS FOR
// ---------------------
// In a pay-first market — Nigeria, the `managed` and `managed-shared` profiles
// — a tenant that has not paid may still open the billing page, the fleet
// page and the import page, because those are the three things it needs to
// pay from. Everything else redirects to the billing page.
//
// THE DEFECT THIS PINS
// ---------------------
// The guard decides that by looking at the PATH it is on, and a server layout
// cannot see the path. The path arrived as the `x-pathname` request header,
// and the only code that set it was `src/lib/supabase/middleware.ts` — a file
// Next.js never loads, because Next loads exactly one middleware and it is
// `src/middleware.ts`. Nothing called that file's `updateSession` either, so
// the header was never set.
//
// The guard was therefore asked about a path it did not have, and the
// allowlist — the list of pages a tenant that has not paid may still open —
// was skipped entirely.
//
// The consequence on a pay-first deployment: a tenant that had not paid was
// redirected to `/ops/billing?notice=payment-required`. The billing page
// sits inside `/ops/layout.tsx`, that layout runs the same guard, the guard
// redirected again, and the tenant was redirected to `/ops/billing` forever.
// An infinite redirect: the operator's own console, unreachable.
//
// So three things are pinned here. The guard redirects a tenant that has not
// paid. It does NOT redirect the page it redirects to. And it cannot redirect
// at all when it does not know where it is.
//
// The middleware side of the same defect — that the path is forwarded, and
// that the path it forwards is the one the SERVER resolved rather than one
// the client chose — is in `tests/unit/hosted-middleware.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const h = vi.hoisted(() => ({
  /** The tenant's subscription status, as the database has it. */
  status: 'unpaid' as string,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  permanentRedirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('@/lib/auth/context', () => ({
  requireTenantContext: async () => ({ tenantId: 'tenant-a', role: 'ops' }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { status: h.status, anniversary_on: null },
          }),
        }),
      }),
    }),
  }),
  createServiceClient: () => {
    throw new Error('the service client is not used by the guard');
  },
}));

/**
 * Run the guard and report where it sent the tenant.
 *
 * `null` means it did not redirect — which is the answer a page on the
 * allowlist must give, and the answer an unknown path must give.
 */
async function redirectTarget(fn: () => Promise<void>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = /^NEXT_REDIRECT:(.*)$/.exec(message);
    if (!match) throw err;
    return match[1];
  }
}

beforeEach(() => {
  vi.resetModules();
  h.status = 'unpaid';
  // The pay-first profile: Nigeria, where the product IS the subscription.
  process.env.DEPLOYMENT_PROFILE = 'managed';
  process.env.DEPLOYMENT_REGION = 'ng';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('the pay-first guard', () => {
  it('redirects a tenant that has not paid to the billing page', async () => {
    const { requireServiceableSubscription } = await import('@/lib/entitlements');
    const target = await redirectTarget(() =>
      requireServiceableSubscription('/ops/drivers', '/ops'),
    );
    expect(target).toBe('/ops/billing?notice=payment-required');
  });

  it('lets the billing page itself through — otherwise the redirect never ends', async () => {
    const { requireServiceableSubscription } = await import('@/lib/entitlements');
    const target = await redirectTarget(() =>
      requireServiceableSubscription('/ops/billing', '/ops'),
    );
    expect(target).toBeNull();
  });

  it('lets the fleet and import pages through — they are how a tenant pays', async () => {
    const { requireServiceableSubscription } = await import('@/lib/entitlements');
    for (const path of ['/ops/fleet', '/ops/import']) {
      expect(
        await redirectTarget(() => requireServiceableSubscription(path, '/ops')),
      ).toBeNull();
    }
  });

  it('does not redirect a tenant it knows nothing about — a redirect that cannot end is an outage', async () => {
    const { requireServiceableSubscription } = await import('@/lib/entitlements');
    const target = await redirectTarget(() =>
      requireServiceableSubscription(null, '/ops'),
    );
    expect(target).toBeNull();
  });

  it('leaves a tenant that has paid alone', async () => {
    h.status = 'active';
    const { requireServiceableSubscription } = await import('@/lib/entitlements');
    const target = await redirectTarget(() =>
      requireServiceableSubscription('/ops/drivers', '/ops'),
    );
    expect(target).toBeNull();
  });

  it('is inert outside a pay-first market', async () => {
    process.env.DEPLOYMENT_PROFILE = 'hosted';
    process.env.DEPLOYMENT_REGION = 'uk';
    const { requireServiceableSubscription } = await import('@/lib/entitlements');
    const target = await redirectTarget(() =>
      requireServiceableSubscription('/ops/drivers', '/ops'),
    );
    expect(target).toBeNull();
  });

  it('has every page it redirects to on its own allowlist', async () => {
    const { SERVICEABLE_ALLOWLIST } = await import('@/lib/entitlements');
    for (const home of ['/ops', '/owner']) {
      expect(SERVICEABLE_ALLOWLIST).toContain(`${home}/billing`);
    }
  });

  it('is a real gate: the tenant it refuses really is not serviceable', async () => {
    // The negative control for the case above. Before the fix the guard had
    // no null-path case at all: an unknown path fell straight through to the
    // redirect. That was only a loop because 'unpaid' is NOT serviceable —
    // if it were, the guard would never have redirected anything and the
    // null-path assertion would have proved nothing.
    const { isServiceable } = await import('@/lib/collection/state');
    expect(isServiceable('unpaid')).toBe(false);
    expect(isServiceable('active')).toBe(true);
  });

  it('is given the path by the layouts that use it', async () => {
    // The guard is only as good as the path it is handed. Both layouts that
    // call it read the forwarded header; if one of them stopped, that portal
    // would loop exactly as the whole guard did.
    const { readFile } = await import('node:fs/promises');
    const layouts = [
      'src/app/ops/layout.tsx',
      'src/app/owner/(portal)/layout.tsx',
    ];
    for (const layout of layouts) {
      const source = await readFile(
        new URL(`../../${layout}`, import.meta.url),
        'utf8',
      );
      expect(source).toContain("headers()).get('x-pathname')");
      expect(source).toContain('requireServiceableSubscription');
    }
  });
});
