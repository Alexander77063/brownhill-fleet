/**
 * The audit row for a self-service password reset.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/product/04-user-flow.md` says every reset is audited, and the
 * OPERATOR's reset was: it went through `recordAudit`, and the trail carried
 * `member.password_reset`. The SELF-SERVICE reset was not audited at all — it
 * changed a password and wrote nothing, so the trail had no record of the one
 * thing a person does to their own account that an administrator might have
 * to answer for.
 *
 * The security review of 2026-11-04 found it.
 *
 * WHAT THE ROW SAYS
 * -----------------
 *   * the action is the SAME one the operator's reset writes — one action,
 *     one meaning, so a query for "every password reset" finds both;
 *   * the member is the account whose password changed;
 *   * the ACTOR is the person themselves. They proved control of the address
 *     on file by reading the link that was sent there. The service
 *     principal is deliberately not a user, and an audit row attributing a
 *     password reset to a named employee would be a lie;
 *   * it says the reset was self-service, because "I forgot my password" and
 *     "the office reset it for me" are different events.
 *
 * WHERE IT IS FILED
 * -----------------
 * `public.audit_log.tenant_id` is NOT NULL and carries a foreign key to
 * `tenants(id)`. One credential opens the account in EVERY tenant the person
 * belongs to, so the reset happened in every one of them, and the row is
 * filed in each.
 *
 * An account that belongs to no tenant has nowhere to file it. That is not a
 * reason to write a row with a made-up tenant: it is reported LOUDLY,
 * because a reset that happened and left no trace is the exact failure this
 * trail exists to prevent.
 *
 * THE WRITER IS INJECTED
 * -----------------------
 * So the rule can be proved without a database. The route hands it
 * `appendAudit` — the one place an audit row is written, and the one that
 * looks at the result of the write.
 */

/** The account whose password was reset. */
export interface PasswordResetAuditAccount {
  /** The account the password belongs to. */
  userId: string;
  /** The role on file at the moment of the reset. */
  role: string;
  /** The tenants the account belongs to, by id. */
  tenantIds: string[];
}

/** One row of the audit trail, on its way in. */
export interface PasswordResetAuditRow {
  /** The tenant the action belongs to. */
  tenantId: string;
  /** The action. The same one the operator's reset writes. */
  action: string;
  /** The kind of thing acted on. */
  entityType: string;
  /** The thing acted on. */
  entityId: string;
  /** Any structured context. */
  detail: Record<string, unknown>;
  /** Who did it. The person, who proved control of the address on file. */
  actor: string;
}

/**
 * The rows a self-service reset writes.
 *
 * One per tenant the account belongs to, and none at all for an account that
 * belongs to no tenant — there is no tenant to file it under, and a row
 * pointing at a tenant the person is not in would be a lie of a different
 * kind.
 */
export function passwordResetAuditRows(
  account: PasswordResetAuditAccount,
): PasswordResetAuditRow[] {
  return account.tenantIds.map((tenantId) => ({
    tenantId,
    action: 'member.password_reset',
    entityType: 'member',
    entityId: account.userId,
    detail: { role: account.role, selfService: true },
    actor: account.userId,
  }));
}

/**
 * Write the rows.
 *
 * Never throws. The password has ALREADY been changed by the time this runs,
 * and a logging failure must not turn a successful reset into an error the
 * person sees — it has to be reported, and nothing more.
 *
 * A refusal to write is reported for the same reason the trail records
 * everything else: a row that is lost is an action that left no trace.
 */
export async function auditPasswordReset(args: {
  /** The account whose password was reset. */
  account: PasswordResetAuditAccount;
  /** Write one row. The route hands it `appendAudit`. */
  write: (row: PasswordResetAuditRow) => Promise<void>;
}): Promise<void> {
  const rows = passwordResetAuditRows(args.account);

  if (rows.length === 0) {
    // There is no tenant to file this under, so there is no row to write.
    // The reset HAPPENED. Say so.
    console.error(
      `[audit] a password reset on ${args.account.userId} could not be filed: ` +
        'the account belongs to no tenant, and an audit row must belong to one',
    );
    return;
  }

  for (const row of rows) {
    try {
      await args.write(row);
    } catch (err) {
      console.error(`[audit] failed to record ${row.action}`, err);
    }
  }
}
