// src/instrumentation.ts
//
// Next.js calls this module's `register()` once at server startup. We use
// it to schedule a daily run of the rent-overdue notification worker, but
// only when the operator has opted in via the
// AUTOMATIONS_RENT_OVERDUE_DAILY=1 env var. Default behaviour is "off" so
// fresh installs don't fire reminders before ops has confirmed the email
// channel and the customer list is correct.
//
// The timer fires once at startup, then every 24 hours. To make it
// deterministic around the day boundary the first fire is anchored to the
// next 09:00 in the local timezone. We don't solve leap-seconds
// here; the worst case is a single missed tick on a daylight-savings
// transition, which the next day's tick will catch.
//
// ── WHY EVERYTHING NODE-ONLY IS INSIDE THE RUNTIME GUARD ────────────────────
//
// Next compiles this file for the Edge runtime as well as Node. The Edge
// runtime has no `setInterval`, no `net`, and no Postgres driver — and
// `rent-overdue` reaches the `postgres` driver through `comms` →
// `tenant-email` → `auth/context` → `auth/local-session` → `db/local`.
//
// With those imports at the top of the file, the *entire build* failed:
//
//   Module not found: Can't resolve 'net'
//   Import trace: postgres → db/local.ts → auth/local-session.ts →
//                 auth/context.ts → email/tenant-email.ts → comms.ts →
//                 automation/rent-overdue.ts → instrumentation.ts
//
// `process.env.NEXT_RUNTIME` is replaced with 'nodejs' or 'edge' at build
// time, so the bundler can drop the branch that does not apply. The imports
// are therefore *dynamic and inside* the guard rather than at the top of the
// file — a static import at the top of the module is in the graph whatever
// the guard says.

const ENABLED = process.env.AUTOMATIONS_RENT_OVERDUE_DAILY === '1';
// Hours of UTC offset to fire at. 9:00 local is the most ops-friendly.
const FIRE_AT_HOUR_LOCAL = 9;

function msUntilNextFire(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(FIRE_AT_HOUR_LOCAL, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Loaded here, not at the top of the file: see the note above.
    const { runRentOverdueCheck } = await import('@/lib/automation/rent-overdue');
    const { listTenantIds } = await import('@/lib/tenancy');

    const runForAllTenants = async (): Promise<void> => {
      let tenants: { id: string; name: string }[] = [];
      try {
        tenants = await listTenantIds();
      } catch (e) {
        // If the DB isn't ready yet (first boot, migrations still running),
        // skip this tick. The next tick will retry.
        console.error('[automation] could not list tenants:', e);
        return;
      }
      for (const t of tenants) {
        try {
          const summary = await runRentOverdueCheck(t.id, null);
          console.log(
            `[automation] rent-overdue tenant=${t.id} (${t.name}) ` +
              `scanned=${summary.scanned} sent=${summary.sent} ` +
              `skipped=${summary.skipped} failed=${summary.failed}`,
          );
        } catch (e) {
          // One tenant failing must not poison the rest of the run.
          console.error(`[automation] rent-overdue failed for ${t.id}:`, e);
        }
      }
    };

    if (!ENABLED) {
      console.log('[automation] rent-overdue: disabled (set AUTOMATIONS_RENT_OVERDUE_DAILY=1 to enable)');
      return;
    }

    const initialDelay = msUntilNextFire();
    console.log(
      `[automation] rent-overdue: enabled; first fire in ${Math.round(initialDelay / 1000)}s`,
    );
    setTimeout(() => {
      void runForAllTenants();
      setInterval(() => {
        void runForAllTenants();
      }, 24 * 60 * 60 * 1000);
    }, initialDelay);
  }
}
