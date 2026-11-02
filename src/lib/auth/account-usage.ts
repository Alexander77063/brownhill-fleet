/**
 * Has this account ever been signed into?
 *
 * The answer decides whether an invite may ADOPT an account — whether it may
 * link somebody else's account to a driver, give it a membership in this
 * tenant and hand it a password.
 *
 * ## Why a marker at all
 *
 * An account that belongs to no tenant looks like nobody's. It is in fact the
 * account a FAILED INVITE left behind: an `auth.users` row, a credential
 * nobody knows, and no membership. Those are adopted, because refusing them
 * leaves the operator with a driver they can never invite.
 *
 * But an account somebody has signed into is different. This product's
 * sessions are stateless tokens whose role is read from the database on every
 * request, so an account with a live session would carry that session into
 * this tenant's driver portal the moment it was given a membership — and
 * replacing the password does not end it. So an account that has been signed
 * into is REFUSED.
 *
 * ## Why a sign-in is the marker
 *
 * A credential cannot tell use from disuse. The credential a failed invite
 * leaves behind is one nobody knows, and it looks exactly like a used one.
 * Only a session proves that somebody got in, so a session is what is
 * recorded.
 *
 * ## Why it is safe to keep in `auth.users.raw_user_meta_data`
 *
 * The marker has to be somewhere the application can write and no user can
 * reach, on every deployment, without a schema change. That is exactly what
 * `auth.users` is:
 *
 *   * it is in the `auth` schema, which PostgREST does not serve — it serves
 *     `public` — so no HTTP caller can reach the table at all;
 *   * no request role holds any privilege on it: `anon`, `authenticated` and
 *     `service_role` have none, so even a table that PostgREST did serve
 *     would be closed to them;
 *   * the only writers are in this repository, and they write it with
 *     `jsonb_build_object` and a LITERAL key, so no user-supplied value can
 *     become the key the marker is read back under.
 *
 * `tests/integration/auth/account-session-marker.test.ts` asserts the second
 * of those against the real database, so the property is checked rather than
 * assumed.
 *
 * A column of its own — `auth.local_credentials.last_successful_sign_in_at`,
 * say — would be tidier, and it is deliberately NOT used: the hosted box only
 * advances its schema when the bootstrap runs, and the documented update path
 * (`git pull && ./hosted/scripts/deploy-app.sh`) does not run it. A fix that
 * depends on a column that might not be there is a fix that does not reach
 * the customer. The column the customer already has is the one that works.
 *
 * ## The lock protocol
 *
 * Two operations must not interleave: minting a session for an account, and
 * adopting that account. Both take the account's rows in the same order —
 * `auth.users` first, then `auth.local_credentials` — and both hold them
 * until they have committed. Two transactions taking the same two locks in
 * different orders can deadlock, so the order is fixed here rather than
 * decided at each call site.
 */
import { localDb, type Query } from '@/lib/db/local';

/**
 * The metadata key the marker is written under.
 *
 * `session_issued_at`, not `last_sign_in_at`: two of the three ways a session
 * is minted are not sign-ins at all (the first-run setup and the phone code),
 * and the marker is about the session, not about the password.
 */
export const SESSION_ISSUED_KEY = 'session_issued_at';

/**
 * Lock an account's rows, always in this order.
 *
 * `auth.users` holds the marker; `auth.local_credentials` holds the password.
 * Locking both means the marker and the credential can never be changed by
 * two transactions at once — which is what makes "has this account been
 * signed into" and "what is this account's password" a single decision rather
 * than two reads that can disagree.
 */
export async function lockAccountRows(tx: Query, userId: string): Promise<void> {
  await tx`
    select id from auth.users where id = ${userId}::uuid for update
  `;
  await tx`
    select user_id from auth.local_credentials where user_id = ${userId}::uuid for update
  `;
}

/**
 * Record that a session has been issued for this account.
 *
 * The write is conditional: an account that already carries the marker is
 * left alone. The marker means "a session has existed for this account", and
 * that is not a thing more sessions make truer.
 *
 * This takes the account's locks, so it cannot interleave with an adoption
 * of the same account.
 */
export async function markSessionIssued(userId: string): Promise<void> {
  const db = await localDb();
  await db.begin(async (tx) => {
    await lockAccountRows(tx, userId);
    await tx`
      update auth.users
      set raw_user_meta_data =
            coalesce(raw_user_meta_data, '{}'::jsonb)
            || jsonb_build_object(${SESSION_ISSUED_KEY}::text, now())
      where id = ${userId}::uuid
        and coalesce(raw_user_meta_data ->> ${SESSION_ISSUED_KEY}::text, '') = ''
    `;
  });
}

/**
 * Has a session ever been issued for this account?
 *
 * True once somebody has got in — by password, by phone code, or through
 * first-run setup. False for an account nobody has ever got into, and for an
 * account that does not exist.
 *
 * Read on its own this is a snapshot; where the answer decides something,
 * read it INSIDE the transaction that acts on it, under the account's locks.
 */
export async function accountHasHadASession(userId: string): Promise<boolean> {
  const db = await localDb();
  const rows = (await db`
    select coalesce(raw_user_meta_data ->> ${SESSION_ISSUED_KEY}::text, '') as issued
    from auth.users
    where id = ${userId}::uuid
    limit 1
  `) as Array<{ issued: string }>;
  return Boolean(rows[0]?.issued);
}
