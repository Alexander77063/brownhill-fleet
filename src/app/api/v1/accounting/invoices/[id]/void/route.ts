// src/app/api/v1/accounting/invoices/[id]/void/route.ts
// POST — cancel an invoice by reversing its own ledger posting.
//
// WHY THIS EXISTS
// ---------------
// An invoice raised by mistake had no way out. There is no edit path, no
// cancel path, and no way to write one off, so a mis-billed week sat in the
// receivables forever and the month-end accounts carried it.
//
// The reversal is the way out: post the mirror of the invoice's own posting,
// mark the invoice void, and leave an audit row naming the operator who did
// it. All three happen in one transaction — an invoice marked void without
// its reversal is a cancelled document still sitting in the ledger.
//
// THE REVERSAL LANDS IN THE INVOICE'S OWN MONTH
// ---------------------------------------------
// An invoice issued in March and voided in November reverses in MARCH. That
// is not a detail: a reversal in November would leave March's revenue, March's
// VAT and March's receivables all carrying an invoice that no longer exists,
// and the operator's VAT return for March would be wrong.
//
// THE ANSWERS
// -----------
//   200 { outcome: 'voided', journalId, period, refundPence }
//   404 { error }              — no such invoice in this tenant
//   409 { error, code }        — already void, or the period is closed/locked
//   403 { error }              — no `billing.write`
//   500 { error, requestId }   — anything unexpected
//
// The 409 for a closed period names the period and who closed it, because
// "something went wrong" is useless to an operator who needs to know which
// month to reopen.

import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/context';
import { MissingChartOfAccountsError } from '@/lib/accounting/chart-of-accounts';
import { periodRefusal } from '@/lib/accounting/periods';
import { withJournalTx } from '@/lib/accounting/journal-bridge';
import { voidInvoiceByReversal } from '@/lib/accounting/invoice-void';

export const runtime = 'nodejs';

/** A uuid, and nothing else. The id goes straight into a `::uuid` cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the operator's reason, if they gave one.
 *
 * Both shapes are accepted — a JSON body from the console's dialog, and a
 * form body from a plain HTML form — because the reason is optional and
 * there is no reason to insist on one of them.
 */
async function readReason(req: NextRequest): Promise<string | null> {
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as { reason?: unknown };
      return typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
    }
    const form = await req.formData();
    const reason = form.get('reason');
    return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  } catch {
    // A malformed body is not a reason to refuse the void: the reason is
    // optional, and the operator's actual intention is to cancel the invoice.
    return null;
  }
}

export async function POST(
  req: NextRequest,
  ctxRoute: { params: Promise<{ id: string }> },
) {
  // The gate. A void is a ledger mutation, so it takes the same
  // `billing.write` permission as the postings it reverses.
  let ctx: Awaited<ReturnType<typeof requirePermission>>;
  try {
    ctx = await requirePermission('billing.write');
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'forbidden' },
      { status: 403 },
    );
  }

  const { id } = await ctxRoute.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Not a valid invoice id.' }, { status: 400 });
  }

  const reason = await readReason(req);

  // The handle that ties an operator's "it said it failed" to the detail on
  // the server. Only handed out when something unexpected goes wrong.
  const requestId = crypto.randomUUID();

  try {
    // One transaction: the reversal, the invoice's status and the audit row
    // land together or not at all.
    const result = await withJournalTx((tx) =>
      voidInvoiceByReversal(tx, ctx, id, reason),
    );

    if (result.outcome === 'not_found') {
      return NextResponse.json({ error: 'No such invoice.' }, { status: 404 });
    }

    if (result.outcome === 'already_void') {
      return NextResponse.json(
        {
          error: 'This invoice has already been voided.',
          code: 'invoice_already_void',
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      ok: true,
      outcome: result.outcome,
      invoiceId: id,
      journalId: result.journalId,
      period: result.period
        ? `${result.period.year}-${String(result.period.month).padStart(2, '0')}`
        : null,
      refundPence: result.refundPence.toString(),
      noLedgerEntry: result.noLedgerEntry,
    });
  } catch (e) {
    // A closed or locked period is a conflict the operator can act on, not a
    // broken button: it says which period, and who closed it.
    const refusal = periodRefusal(e);
    if (refusal) {
      return NextResponse.json(refusal.body, { status: refusal.status });
    }

    // A missing account is the installation's problem, not the operator's,
    // and it is named by its code so whoever fixes it knows which one. The
    // account code is a chart-of-accounts constant, not a secret and not a
    // detail of the request, so it is safe to say.
    if (e instanceof MissingChartOfAccountsError) {
      return NextResponse.json(
        { error: `Chart of accounts: no account with code ${e.code}.`, requestId },
        { status: 500 },
      );
    }

    // Anything else is unexpected. The detail stays on the server — it can
    // name a column, a constraint or a file path, none of which belong in a
    // response the operator's browser reads — and the request id is the
    // handle that ties the two together.
    console.error(`[accounting/invoices/void] void failed (request ${requestId})`, e);
    return NextResponse.json(
      { error: 'Could not void this invoice.', requestId },
      { status: 500 },
    );
  }
}
