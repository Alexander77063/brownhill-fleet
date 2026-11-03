/**
 * The test-token minter's own guard.
 *
 * `hosted/tests/auth/mint-test-jwt.mjs` mints a bearer token that the
 * application's middleware accepts. It runs on the deployed box, where it
 * signs with the deployment's REAL signing secret — so two things about it
 * matter more than anything else:
 *
 *   1. The secret must come from the ENVIRONMENT. On Linux
 *      `/proc/<pid>/cmdline` is world-readable, so a secret passed as an
 *      argument is readable by every account on the box — and anyone who
 *      could read it could mint a session for any user in any tenant.
 *
 *   2. There must be NO FALLBACK. The minter used to sign with a fixed
 *      string that is committed in this repository when no secret was in the
 *      environment. The middleware does not verify signatures — it reads the
 *      claims it needs — so that token was a working session for any user in
 *      any tenant, handed out without complaint to anyone who simply forgot
 *      to set a variable. A fallback secret is not a test fixture here; it
 *      is a master key with the documentation of a placeholder.
 *
 * Neither of those is visible in a build log, so they are pinned here by
 * running the real minter: a real child process, with a real environment,
 * signing real tokens that are verified against the real signer.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyJwt } from '@/lib/auth/jwt';

const MINTER = fileURLToPath(
  new URL('../../hosted/tests/auth/mint-test-jwt.mjs', import.meta.url),
);

const ENV_SECRET = 'environment-secret-for-the-guard';
const ARGV_SECRET = 'argument-secret-that-must-never-be-used';

interface MinterRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the minter with a controlled environment.
 *
 * `MINT_JWT_SECRET` is removed first and only put back when the test asks
 * for it, so a secret left over in the developer's own shell — or in CI's
 * environment — cannot make the "refuses without a secret" case pass by
 * accident. The "refuses" case has to fail for the right reason, or it is
 * not a guard at all.
 */
function runMinter(args: string[], env: Record<string, string> = {}): MinterRun {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.MINT_JWT_SECRET;
  for (const [key, value] of Object.entries(env)) childEnv[key] = value;

  const result = spawnSync(process.execPath, [MINTER, ...args], {
    encoding: 'utf8',
    env: childEnv,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('the test-token minter', () => {
  it('signs with the secret from the environment', () => {
    const run = runMinter(['tenant-A', 'subject-A'], { MINT_JWT_SECRET: ENV_SECRET });

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).not.toBe('');
    expect(run.stdout.endsWith('\n')).toBe(false);
    expect(run.stdout.split('.')).toHaveLength(3);
  });

  it('mints a token the application’s own signer accepts', async () => {
    const run = runMinter(['tenant-A', 'subject-A'], { MINT_JWT_SECRET: ENV_SECRET });

    const result = await verifyJwt(run.stdout, ENV_SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The claims the application itself mints. The old proof signed
    // `{uid, role:'owner'}` — the application produces neither — so a token
    // that verifies is not the same thing as a token the middleware accepts.
    expect(result.claims.sub).toBe('subject-A');
    expect(result.claims.role).toBe('authenticated');
    expect(result.claims.tenant_id).toBe('tenant-A');
  });

  it('ignores a secret passed on the command line', async () => {
    // The secret is in the environment AND on the command line, and the two
    // are different. The environment wins, and the argument is ignored
    // outright — including as the subject, which is the second positional
    // argument the minter reads.
    const run = runMinter(['tenant-A', 'subject-A', ARGV_SECRET], {
      MINT_JWT_SECRET: ENV_SECRET,
    });

    expect(run.status).toBe(0);

    const withEnvSecret = await verifyJwt(run.stdout, ENV_SECRET);
    expect(withEnvSecret.ok).toBe(true);

    // The argument secret did not sign this token. If it had, this token
    // would be a credential anyone who can read a process listing could
    // forge.
    const withArgvSecret = await verifyJwt(run.stdout, ARGV_SECRET);
    expect(withArgvSecret.ok).toBe(false);
    if (withArgvSecret.ok) return;
    expect(withArgvSecret.reason).toBe('bad-signature');

    // And the extra argument did not become the subject either.
    if (!withEnvSecret.ok) return;
    expect(withEnvSecret.claims.sub).toBe('subject-A');
  });

  it('refuses to sign at all when no secret is in the environment', () => {
    const run = runMinter(['tenant-A', 'subject-A']);

    expect(run.status).not.toBe(0);
    // No token on stdout. A token on stdout would be the master key with a
    // token-shaped wrapper.
    expect(run.stdout.trim()).toBe('');

    // And the refusal says what to do, because an operator who hits this on
    // the box has to be able to fix it without reading the minter's source.
    expect(run.stderr).toMatch(/MINT_JWT_SECRET/);
  });

  it('refuses to sign even when a secret is handed to it on the command line', () => {
    // The dangerous shape: a caller who believes passing the secret as an
    // argument works. It must not work, and it must fail loudly.
    const run = runMinter(['tenant-A', 'subject-A', ARGV_SECRET]);

    expect(run.status).not.toBe(0);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toMatch(/MINT_JWT_SECRET/);
  });
});
