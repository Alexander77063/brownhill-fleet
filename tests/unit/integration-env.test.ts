// tests/unit/integration-env.test.ts
//
// The rule that decides whether an integration test runs or skips.
//
// `tests/helpers/integration-env.ts` is the rule every accounting
// integration test now asks instead of hand-rolling its own guard. The
// hand-rolled guards all looked the same:
//
//   const DATABASE_URL = process.env.DATABASE_URL;
//   if (!DATABASE_URL) { console.warn('… being SKIPPED …'); }
//   describe.skipIf(!DATABASE_URL)(…)
//
// and every one of them SKIPPED — in both modes. The hosted-smoke job sets
// REQUIRE_INTEGRATION=1 precisely so that a missing database is a FAILURE and
// not a skip, because a skip reads exactly like a pass in a build log. Those
// guards ignored REQUIRE_INTEGRATION entirely, so the hosted-smoke job could
// report those files' tests as skipped and still be green.
//
// The helper is the fix. Its whole value is the throw:
//
//   if (process.env.REQUIRE_INTEGRATION === '1') {
//     throw new Error(`REQUIRE_INTEGRATION=1 was set, but ${missing.join(' and ')} …`);
//   }
//
// Take that throw away and the helper becomes the thing it replaced: a skip
// that looks like a pass. So the throw is what this file is about.
//
// A gate that cannot fail is not a gate. This test is the negative control
// for that throw: every case below is a way of removing the environment, and
// the test requires the helper to REFUSE, loudly and by name, rather than
// hand back a null that a `describe.skipIf` will swallow.
//
// The negative control is the point. If the throw were removed tomorrow, this
// file would fail — and the failure would name the exact behaviour that
// disappeared.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrationEnv } from '../helpers/integration-env';

// The three variables the helper reads. Nothing else in the environment can
// change its answer, and the test must not depend on what the machine
// running it happens to have.
const MANAGED = ['DATABASE_URL', 'APP_ORIGIN', 'REQUIRE_INTEGRATION'] as const;

type Managed = (typeof MANAGED)[number];

// Put the environment into a known state.
//
// Every managed variable is set on every call, including the ones being
// removed — `vi.stubEnv(name, undefined)` deletes the variable outright,
// rather than setting it to the string "undefined".
function environment(values: Partial<Record<Managed, string>> = {}) {
  for (const name of MANAGED) {
    vi.stubEnv(name, values[name]);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('integrationEnv', () => {
  describe('when the job has said the environment is required', () => {
    it('throws and names DATABASE_URL when there is no database', () => {
      environment({ REQUIRE_INTEGRATION: '1', APP_ORIGIN: 'http://127.0.0.1:3000' });

      expect(() => integrationEnv()).toThrow(/DATABASE_URL/);
    });

    it('throws and names APP_ORIGIN when there is no application', () => {
      environment({ REQUIRE_INTEGRATION: '1', DATABASE_URL: 'postgres://db/brownhill' });

      expect(() => integrationEnv()).toThrow(/APP_ORIGIN/);
    });

    it('names every missing value at once, and says they are missing', () => {
      environment({ REQUIRE_INTEGRATION: '1' });

      expect(() => integrationEnv()).toThrow(/DATABASE_URL and APP_ORIGIN are missing/);
    });

    it('says that a test which did not run is not a test which passed', () => {
      environment({ REQUIRE_INTEGRATION: '1' });

      expect(() => integrationEnv()).toThrow(/did not run is not a test that passed/);
    });

    it('leaves a test that only needs the database alone', () => {
      environment({ REQUIRE_INTEGRATION: '1', DATABASE_URL: 'postgres://db/brownhill' });

      expect(() => integrationEnv({ app: false })).not.toThrow();
    });

    it('hands the environment back when everything is there', () => {
      environment({
        REQUIRE_INTEGRATION: '1',
        DATABASE_URL: 'postgres://db/brownhill',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      });

      expect(integrationEnv()).toEqual({
        DATABASE_URL: 'postgres://db/brownhill',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      });
    });
  });

  describe('when the job has not asked for the integration tests', () => {
    it('returns null rather than throwing', () => {
      environment({});
      // The helper warns on the way out. That warning is the point of the
      // helper — it is the skip, out loud — but this test is about the
      // return value, and the warning is asserted on in the case below.
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(integrationEnv()).toBeNull();
    });

    it('says, out loud, that it is skipping', () => {
      environment({});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      integrationEnv();

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/SKIPPED/);
      expect(warn.mock.calls[0][0]).toMatch(/DATABASE_URL/);
    });

    it('treats any value other than "1" as not required', () => {
      // A job that set REQUIRE_INTEGRATION=true, or =yes, or =0 has not
      // asked for the integration tests. Only the exact string "1" does.
      environment({ REQUIRE_INTEGRATION: 'true' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(integrationEnv()).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('what it hands back', () => {
    it('hands back only what the test asked for', () => {
      environment({
        DATABASE_URL: 'postgres://db/brownhill',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      });

      expect(integrationEnv({ app: false })).toEqual({ DATABASE_URL: 'postgres://db/brownhill' });
    });

    it('trims the values', () => {
      environment({
        DATABASE_URL: '  postgres://db/brownhill  ',
        APP_ORIGIN: '  http://127.0.0.1:3000  ',
      });

      expect(integrationEnv()).toEqual({
        DATABASE_URL: 'postgres://db/brownhill',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      });
    });

    it('reads the environment on every call, not once at module load', () => {
      // The helper's own docstring used to say the opposite — "Both of the
      // values are read once, at module load" — while the code read them on
      // every call. This pins what the code does, so the docstring can be
      // corrected to match instead of the other way round.
      environment({
        REQUIRE_INTEGRATION: '1',
        DATABASE_URL: 'postgres://db/brownhill',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      });
      expect(integrationEnv()).toEqual({
        DATABASE_URL: 'postgres://db/brownhill',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      });

      environment({ REQUIRE_INTEGRATION: '1', APP_ORIGIN: 'http://127.0.0.1:3000' });
      expect(() => integrationEnv()).toThrow(/DATABASE_URL/);
    });
  });
});
