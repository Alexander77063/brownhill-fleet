// tests/integration/accounting/booking-series-dates.test.ts
//
// The dates the ops screens read from booking_series, against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// `/ops` and `/ops/series` are the operations dashboard and the recurring
// bookings page. Both went 500 as soon as a series existed.
//
// `booking_series.start_date` and `end_date` are `date` columns, and
// postgres.js hands a raw `date` back as a JavaScript Date. The expansion
// helper expects 'YYYY-MM-DD' and does
//
//     const [y, m, d] = yyyyMmDd.split('-')
//
// so a Date threw `TypeError: yyyyMmDd.split is not a function` inside
// `expandSeries()`, which is what `upcomingOccurrences()` calls.
//
// The unit test missed it because it passed string dates — a shape the
// database has never produced. This file reads through the real query
// function, against the real schema, and asserts the shape the ops pages
// depend on.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant and series, and removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { listSeries, upcomingOccurrences } from '@/lib/queries-booking-series';
import { integrationEnv } from '../../helpers/integration-env';

// This file talks straight to postgres and never through the service
// client, so it asks for the database alone.
//
// `integrationEnv` is the repository's rule for this, and it is the rule that
// matters: it SKIPS, out loud, when the job has not asked for the
// integration tests, and it FAILS when the job has set REQUIRE_INTEGRATION=1
// and the database is not there. The hand-rolled guard this replaced skipped
// in BOTH cases — so a build with REQUIRE_INTEGRATION=1 could report this
// file's tests as skipped and still be green. A test that did not run is not
// a test that passed.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('the ops booking series, against a real postgres', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const slug = `series-dates-${tenantId.slice(0, 8)}`;

  const START_DATE = '2026-09-01';
  const END_DATE = '2026-09-07';

  let seriesId = '';

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Booking series dates test', ${slug})
    `;

    seriesId = randomUUID();
    await sql`
      insert into public.booking_series
        (id, tenant_id, pickup, dropoff, start_time, days_of_week,
         start_date, end_date, horizon_weeks, status)
      values (${seriesId}::uuid, ${tenantId}::uuid, 'Heathrow', 'Mayfair', '08:00',
              array[1, 3, 5], ${START_DATE}::date, ${END_DATE}::date, 4, 'active')
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.booking_series where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
  });

  it('loads the series days as the YYYY-MM-DD strings the expansion needs', async () => {
    const rows = await listSeries(tenantId, { status: 'active' });
    const row = rows.find((r) => r.id === seriesId);
    expect(row, 'the series is not in the list').toBeTruthy();

    expect(
      typeof row!.startDate,
      'start_date came back as a Date, so expandSeries() threw and the ops pages 500d',
    ).toBe('string');
    expect(row!.startDate).toBe(START_DATE);
    expect(typeof row!.endDate).toBe('string');
    expect(row!.endDate).toBe(END_DATE);
  });

  it('loads the created-at stamp as a string', async () => {
    const rows = await listSeries(tenantId, { status: 'active' });
    const row = rows.find((r) => r.id === seriesId);
    expect(row, 'the series is not in the list').toBeTruthy();

    expect(typeof row!.createdAt).toBe('string');
    expect(Number.isNaN(new Date(row!.createdAt).getTime())).toBe(false);
  });

  it('expands the loaded series into its booking dates', async () => {
    const rows = await listSeries(tenantId, { status: 'active' });
    const row = rows.find((r) => r.id === seriesId);
    expect(row, 'the series is not in the list').toBeTruthy();

    // The exact call src/app/ops/series/page.tsx and src/app/ops/page.tsx make.
    expect(() => upcomingOccurrences(row!)).not.toThrow();
    expect(upcomingOccurrences(row!)).toEqual(['2026-09-02', '2026-09-04', '2026-09-07']);
  });
});
