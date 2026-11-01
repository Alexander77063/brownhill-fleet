// src/app/api/v1/accounting/periods/close/route.ts
// POST — close a monthly accounting period, with the operator's eyes on what
// the close affects.
//
// WHY THIS EXISTS
// ---------------
// The Close button closed a month with one click and no warning. The spec
// asks for "Close period (warns: locks all postings; shows affected counts;
// confirm modal)" — nothing warned, nothing counted, and nothing confirmed.
// An operator closing October with uncategorised bank lines and an unfiled
// VAT return found out afterwards, when a posting came back 409 and the
// month was already shut.
//
// This is the ONE way to close a period. The old server action
// (`closePeriodAction`) is gone: two paths to the same close is two ways to
// skip the confirmation, and the one that skipped it was the one the button
// used.
//
// THE SHAPE OF THE REQUEST
// -------------------------
//   POST { period: '2026-10' }
//     → 428 with the counts and the warnings. Nothing was closed. This is
//       what the confirm dialog is built from.
//
//   POST { period: '2026-10', confirm: true, acknowledge: [...] }
//     → 200 and the period is closed.
//
// The `acknowledge` list is the operator saying "I have seen this", with the
// FIGURES they saw: how many open bank items, worth how much. Every warning
// the server reports must be in it, with the same figures. So if a bank line
// lands while the dialog is open, the close is refused again and the dialog
// shows the new figures — the operator cannot shut a month over something
// they have not seen.
//
// 428 is Precondition Required (RFC 6585): the request was understood, and
// the precondition it was missing is the confirmation. It is not a 400 —
// nothing about the request was malformed — and it is not a 409 — nothing
// conflicts with the server's state.
//
// THE CLOSE IS ONE TRANSACTION
// ----------------------------
// The read of the warnings and the close that acts on them used to be two
// separate transactions, with nothing between them. A bank line landing in
// that window was closed over unseen. They are now one transaction under
// the period's advisory lock, so the counts the operator acknowledged and
// the counts the close acts on are the same counts. The transaction lives
// in `src/lib/accounting/close.ts`, because a transaction that can only be
// exercised through HTTP is a transaction nobody tests directly.
//
// WHAT THE CONFIRMATION IS AND IS NOT
// -----------------------------------
// It is an ATTENTION control, not a security control. Anyone who can reach
// this route can send `confirm: true`; there is no secret here and there is
// not meant to be. What it guarantees is that the product never closes a
// month by accident: there is no one-click path, and the only path that
// closes one is the one that shows the counts.
//
// A close of an already-closed period is a 409 that names the period and who
// closed it — the same typed refusal the reconcile route answers with. The
// refusal is built by the same helper, so the two surfaces cannot drift.

import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/context';
import { preflightPeriodClose } from '@/lib/accounting/close-preflight';
import { closePeriodConfirmed } from '@/lib/accounting/close';
import { parseAcknowledgements, type UntrustedCloseRequestBody } from '@/lib/accounting/close-request';
import { AccountingPeriodError, periodRefusal } from '@/lib/accounting/periods';

export const runtime = 'nodejs';

/**
 * The body the client sends.
 *
 * Its shape comes from the client's own request type, so the route reads
 * exactly the keys the dialog sends. The two ends used to disagree — the
 * dialog sent `acknowledge: undefined` and the route read `acknowledge` —
 * and nothing said so until the operator found they could never close a
 * period. Now a key that is renamed in one place stops the other from
 * compiling.
 *
 * The values are `unknown`: the body is untrusted JSON, and every one of
 * them is checked before it is used.
 */
type CloseRequestBody = UntrustedCloseRequestBody;

/**
 * Parse 'YYYY-MM'.
 *
 * Strict on purpose: a period that is not exactly a year and a month is a
 * period nobody meant, and guessing at it (letting '2026-13' become January
 * 2027) is how a month gets closed that should not have been.
 */
function parsePeriod(raw: unknown): { year: number; month: number } | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;
  // The same bounds the database enforces on accounting.periods.
  if (year < 2000 || year > 2100) return null;
  return { year, month };
}

export async function POST(req: NextRequest) {
  // C1: gate. The close is a ledger mutation, so it takes the same
  // `billing.write` permission as the postings it locks.
  let ctx: Awaited<ReturnType<typeof requirePermission>>;
  try {
    ctx = await requirePermission('billing.write');
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'forbidden' },
      { status: 403 },
    );
  }

  let body: CloseRequestBody = {};
  try {
    body = (await req.json()) as CloseRequestBody;
  } catch {
    body = {};
  }

  const ym = parsePeriod(body.period);
  if (!ym) {
    return NextResponse.json(
      { error: 'period must be YYYY-MM.' },
      { status: 400 },
    );
  }

  // ── the first request: "what would closing this do?" ────────────────────
  //
  // Nothing is written, so nothing needs to be locked. The counts here are
  // what the dialog is built from; the close re-reads them itself, under
  // the lock, and compares.
  if (body.confirm !== true) {
    const preflight = await preflightPeriodClose(ctx.tenantId, ym.year, ym.month);

    // A period that cannot be closed is a conflict, and it says which one
    // and who closed it.
    if (!preflight.canClose) {
      const refusal = periodRefusal(
        new AccountingPeriodError(
          preflight.status === 'locked' ? 'period_locked' : 'period_already_closed',
          ym.year,
          ym.month,
          preflight.closedAt ? new Date(preflight.closedAt) : null,
          preflight.closedByUserId,
          preflight.lockedAt ? new Date(preflight.lockedAt) : null,
        ),
      );
      return NextResponse.json(refusal!.body, { status: refusal!.status });
    }

    return NextResponse.json(
      {
        error: 'Closing a period must be confirmed.',
        code: 'confirmation_required',
        preflight,
      },
      { status: 428 },
    );
  }

  // ── the confirmed request ───────────────────────────────────────────────
  //
  // The handle that ties an operator's "it said it failed" to the detail on
  // the server. Only handed out when something unexpected goes wrong.
  const requestId = crypto.randomUUID();

  try {
    const result = await closePeriodConfirmed({
      tenantId: ctx.tenantId,
      year: ym.year,
      month: ym.month,
      userId: ctx.userId,
      acknowledge: parseAcknowledgements(body.acknowledge),
    });

    if (result.outcome === 'closed') {
      return NextResponse.json({
        ok: true,
        closed: true,
        period: result.preflight.period,
        closedAt: result.period.closedAt ? result.period.closedAt.toISOString() : null,
        closedByUserId: result.period.closedByUserId,
        warnings: result.preflight.warnings,
      });
    }

    if (result.outcome === 'not_closeable') {
      return NextResponse.json(result.refusal, { status: 409 });
    }

    // Something the operator has not acknowledged: either a warning they
    // never saw, or one whose figures changed while the dialog was open.
    // The fresh preflight travels with the refusal so the dialog can show
    // them what it is now.
    return NextResponse.json(
      {
        error:
          'These warnings have not been acknowledged: ' +
          result.outstanding.map((w) => w.code).join(', '),
        code: 'confirmation_required',
        preflight: result.preflight,
      },
      { status: 428 },
    );
  } catch (e) {
    // Somebody else closed it between the preflight and the close. The
    // refusal names the period and its closer.
    const refusal = periodRefusal(e);
    if (refusal) {
      return NextResponse.json(refusal.body, { status: refusal.status });
    }
    // Anything else is unexpected. The detail stays on the server — it can
    // name a column, a constraint or a file path, none of which belong in a
    // response the operator's browser reads — and the request id is the
    // handle that ties the two together.
    console.error(`[periods/close] close failed (request ${requestId})`, e);
    return NextResponse.json(
      { error: 'Could not close this period.', requestId },
      { status: 500 },
    );
  }
}
