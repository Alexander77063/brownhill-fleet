/**
 * scripts/seed-auth-policy.mjs — which password the demo seed may use, and
 * where it may write.
 *
 * The seed creates seven accounts with real rights: ops, accounts, two
 * investors, a driver and an owner. It used to carry a built-in password, so
 * that the handover demonstration was one command rather than a ritual of
 * copying a value out of a shell.
 *
 * That built-in password was published in this repository. It is gone, and
 * so is every other way this script could leak one:
 *
 *   - It does not carry a password. There is no credential in this file.
 *   - It does not generate one. A generated password printed to stdout ends
 *     up in terminal scrollback, in CI logs and in transcripts — the same
 *     exposure as publishing it, with more steps.
 *   - It never echoes one back. A password the operator chose is already
 *     theirs; repeating it helps nobody.
 *
 * The operator supplies the password. It exists in their terminal and
 * nowhere else.
 *
 * The second rule is about *where* the seed may write, and it is about the
 * accounts rather than the password. The seven demo personas carry real IAM
 * roles — one of them `tenant_admin` — on a real tenant. Pointed at a
 * customer's server, the seed would insert seven invented people into their
 * user list, one of them an administrator. So the seed refuses any target
 * that is not on the machine running it. An operator who means it can say so
 * with SEED_ALLOW_REMOTE=1.
 *
 * Kept in its own module so the rule can be tested without a database, and so
 * the seed script itself stays about seeding.
 */

/** Thrown when the seed would not be safe to run. */
export class SeedPasswordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedPasswordError';
  }
}

/** The host part of a database URL, or '' when there is none (a socket path). */
function databaseHost(databaseUrl) {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * Is this database on the machine running the script?
 *
 * Loopback addresses and `localhost` are local. So is a URL with no host at
 * all — that is a unix socket, which is by definition on this machine.
 */
export function isLocalDatabase(databaseUrl) {
  const host = databaseHost(databaseUrl);
  if (!host) return true;
  if (host === 'localhost') return true;
  if (host === '::1' || host === '[::1]') return true;
  // A strict IPv4 loopback: four dotted octets, each starting 127. Written
  // this way so `127.0.0.1.evil.example` — a name that merely begins with the
  // loopback prefix — is not mistaken for one.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The password to create the demo accounts with, and whether the seed may run
 * at all.
 *
 * @param {{ databaseUrl: string, explicitPassword?: string | undefined, allowRemote?: boolean }} args
 * @returns {{ password: string, source: 'explicit' }}
 * @throws {SeedPasswordError} when no password was supplied, or when the
 *   target database is not on this machine and the operator has not explicitly
 *   allowed it.
 */
export function resolveSeedPassword({ databaseUrl, explicitPassword, allowRemote = false }) {
  const explicit = typeof explicitPassword === 'string' ? explicitPassword.trim() : '';
  if (!explicit) {
    throw new SeedPasswordError(
      'seed-auth: SEED_PASSWORD is not set.\n' +
        '          No password is published in this repository, and none is generated\n' +
        '          here — a password that is printed out is a password that ends up\n' +
        '          in scrollback, in logs and in transcripts.\n' +
        '          Set SEED_PASSWORD to a value you choose. Every demo account gets\n' +
        '          it, so one value signs you in as any of the seven roles.',
    );
  }

  if (!isLocalDatabase(databaseUrl) && !allowRemote) {
    throw new SeedPasswordError(
      'seed-auth: refusing to write the demo accounts to a database that is not on\n' +
        '          this machine.\n' +
        '          These are seven invented people — ops, accounts, two investors, a\n' +
        '          driver and an owner — and one of them holds the tenant_admin role.\n' +
        '          Pointed at a real server they would land in a real customer\'s user\n' +
        '          list as real administrators.\n' +
        '          Point DATABASE_URL at a local database (docker compose up gives\n' +
        '          you one), or set SEED_ALLOW_REMOTE=1 if you genuinely mean to seed\n' +
        '          this server.',
    );
  }

  return { password: explicit, source: 'explicit' };
}
