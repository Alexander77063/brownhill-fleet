import { type NextRequest, NextResponse } from 'next/server';
import { addDays, daysBetween, isCronAuthorized, todayISO } from '@/lib/cron';
import { rtbEquityAtWeek } from '@/lib/finance';
import { localDb } from '@/lib/auth/local-store';
import { postInvoiceToLedger } from '@/lib/accounting/gl-posting';
import { requireInferredVatCodeId } from '@/lib/accounting/vat-codes';
import { withJournalTx } from '@/lib/accounting/journal-bridge';

// Weekly cron: accrue rent (rent_schedule + invoice) for every active agreement
// up to the current week, backfilling any missed weeks since start_date, and
// append the RTB equity ledger for rent-to-buy agreements. Fully idempotent.
export const runtime = 'nodejs';

const MAX_WEEKS = 200; // safety cap (RTB term is 156 weeks)

// THE INVOICE AND ITS LEDGER ENTRY ARE ONE TRANSACTION
// -----------------------------------------------------
// The invoice used to be written through PostgREST and the ledger entry was
// never written at all: `postInvoiceJournal` had no call site anywhere in
// the product. So the operator's trial balance did not contain the rent
// they were billing — it contained only the handful of bank lines somebody
// had reconciled by hand.
//
// Now they are one transaction. That is not tidiness, it is the difference
// between two kinds of wrong:
//
//   * an invoice with no ledger entry — the operator bills for a car and the
//     accounts do not know it happened;
//   * a ledger entry with no invoice — the accounts show revenue nobody can
//     point at.
//
// One transaction means neither can happen. If the posting is refused (a
// closed period, a missing account), the invoice is not created either.
//
// THE INVOICE'S ISSUE DATE IS THE RENT WEEK IT BILLS
// ---------------------------------------------------
// `issued_on` used to be "today" — the day the cron happened to run. The cron
// backfills EVERY week since the agreement started, so a six-month-old
// agreement raised six months of rent on the same day, all dated today, and
// all of it landed in this month's VAT return and this month's trial
// balance.
//
// The seed already uses the other convention: `issued_on` = the week's
// `period_start`, which is also `due_on`. An invoice for the week that began
// on the 28th is issued on the 28th and due on the 28th — the rent is
// billed in advance for the week it is for. That puts the invoice, its
// ledger entry, the VAT return and the receivables ageing in the same month,
// which is the only way those four can agree with each other.

interface AgreementRow {
  id: string;
  tenant_id: string;
  type: 'standard' | 'rtb';
  start_date: string | null;
  weekly_gross_pence: string;
  weekly_net_pence: string;
  weekly_vat_pence: string;
  deposit_pence: string;
  option_credit_weekly_pence: string | null;
}

/** What happened to one agreement-week. */
interface WeekOutcome {
  invoiceCreated: boolean;
  rentScheduleCreated: boolean;
  journalId: string | null;
}

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sql = await localDb();
  const today = todayISO();

  const agreements = (await sql`
    select id, tenant_id, type::text as type, start_date::text as start_date,
           weekly_gross_pence, weekly_net_pence, weekly_vat_pence,
           deposit_pence, option_credit_weekly_pence
      from public.agreements
     where status = 'active'
  `) as AgreementRow[];

  let rentRows = 0;
  let invoices = 0;
  let posted = 0;
  let equityRows = 0;

  // A week that could not be billed — a closed period, a missing account —
  // is recorded and the run carries on. One bad week must not stop the other
  // weeks from being billed, and the operator is told exactly which weeks
  // did not land and why.
  const failures: Array<{ agreementId: string; week: number; error: string }> = [];

  for (const raw of agreements) {
    const startDate = raw.start_date;
    if (!startDate) continue;

    // week_no for `today`, anchored to start_date (week 1 = start_date..+6d).
    const elapsed = daysBetween(startDate, today);
    if (elapsed < 0) continue;
    const currentWeek = Math.min(Math.floor(elapsed / 7) + 1, MAX_WEEKS);

    for (let week = 1; week <= currentWeek; week++) {
      const periodStart = addDays(startDate, (week - 1) * 7);
      const periodEnd = addDays(periodStart, 6);

      // A deterministic invoice number, so re-runs never double-bill even if
      // a prior run created the schedule but not the invoice. due_on = the
      // week's period_start, and issued_on = the same day.
      const number = `INV-${raw.id.slice(0, 8)}-W${week}`;

      let outcome: WeekOutcome;
      try {
        outcome = await withJournalTx(async (tx) => {
          // 1) rent_schedule (unique agreement_id+week_no). Insert; tolerate dupes.
          //
          //    The tenant is the AGREEMENT's tenant. Omitting it is not a
          //    no-op: the column defaults to the seed tenant, so every other
          //    tenant's rent would silently land in the seed tenant's books.
          const rsInserted = (await tx`
            insert into public.rent_schedule
              (tenant_id, agreement_id, week_no, period_start, period_end,
               gross_due_pence, net_due_pence, vat_due_pence)
            values (${raw.tenant_id}::uuid, ${raw.id}::uuid, ${week},
                    ${periodStart}::date, ${periodEnd}::date,
                    ${raw.weekly_gross_pence}, ${raw.weekly_net_pence},
                    ${raw.weekly_vat_pence})
            on conflict (agreement_id, week_no) do nothing
            returning id
          `) as Array<{ id: string }>;

          let rentScheduleId = rsInserted[0]?.id ?? null;
          const rentScheduleCreated = rentScheduleId !== null;
          if (!rentScheduleId) {
            const existing = (await tx`
              select id from public.rent_schedule
               where agreement_id = ${raw.id}::uuid
                 and week_no = ${week}
            `) as Array<{ id: string }>;
            rentScheduleId = existing[0]?.id ?? null;
          }

          // 2) The invoice, and the ledger entry it belongs to.
          //
          //    The VAT code is resolved BEFORE the invoice is written, and a
          //    missing one is fatal for the week: `public.invoices.vat_code_id`
          //    is what the VAT return aggregates on, and an invoice with no
          //    code is an invoice the return cannot see. That is how the
          //    return came to report £0 of output VAT against a book of
          //    £40,000 of rentals — every invoice carried a null code.
          const vatCodeId = await requireInferredVatCodeId(
            tx,
            BigInt(raw.weekly_vat_pence),
            raw.tenant_id,
          );

          const invInserted = (await tx`
            insert into public.invoices
              (tenant_id, agreement_id, rent_schedule_id, number, issued_on, due_on,
               gross_pence, net_pence, vat_pence, vat_code_id)
            values (${raw.tenant_id}::uuid, ${raw.id}::uuid, ${rentScheduleId}::uuid,
                    ${number}, ${periodStart}::date, ${periodStart}::date,
                    ${raw.weekly_gross_pence}, ${raw.weekly_net_pence},
                    ${raw.weekly_vat_pence}, ${vatCodeId}::uuid)
            on conflict (number) do nothing
            returning id
          `) as Array<{ id: string }>;

          const created = invInserted.length > 0;

          // The invoice, whether this run made it or an earlier one did. Its
          // OWN figures and its OWN issue date are what the ledger entry is
          // built from — a week billed by a previous build of this cron is
          // posted with that week's dates, not with today's.
          const invoiceRows = (await tx`
            select id, issued_on::text as issued_on,
                   gross_pence, net_pence, vat_pence,
                   posted_journal_id, vat_code_id
              from public.invoices
             where number = ${number}
             for update
          `) as Array<{
            id: string;
            issued_on: string;
            gross_pence: string;
            net_pence: string;
            vat_pence: string;
            posted_journal_id: string | null;
            vat_code_id: string | null;
          }>;
          const invoice = invoiceRows[0];
          if (!invoice) {
            throw new Error(`rent cron: invoice ${number} vanished between the insert and the read.`);
          }

          // An invoice raised before the ledger was wired carries no VAT code
          // and no journal entry. Give it the code it should have had.
          if (!invoice.vat_code_id) {
            await tx`
              update public.invoices
                 set vat_code_id = ${vatCodeId}::uuid
               where id = ${invoice.id}::uuid
            `;
          }

          // 3) The ledger entry. `posted_journal_id` is the guard: an
          //    invoice that already has one was posted by an earlier run, and
          //    the journal's own idempotency key would return the same entry
          //    anyway — but going through the guard means a re-run of the cron
          //    does not even take the period lock, so a re-run never fails
          //    because a month was closed after the original posting.
          let journalId: string | null = null;
          if (!invoice.posted_journal_id) {
            journalId = await postInvoiceToLedger(tx, { userId: null, tenantId: raw.tenant_id }, {
              id: invoice.id,
              netPence: BigInt(invoice.net_pence),
              vatPence: BigInt(invoice.vat_pence),
              grossPence: BigInt(invoice.gross_pence),
              issuedOn: invoice.issued_on,
            });
          }

          return { invoiceCreated: created, rentScheduleCreated, journalId };
        });
      } catch (err) {
        failures.push({
          agreementId: raw.id,
          week,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (outcome.rentScheduleCreated) rentRows++;
      if (outcome.invoiceCreated) invoices++;
      if (outcome.journalId) posted++;
    }

    // 4) RTB equity ledger row (cumulative option credit + deposit).
    //
    //    The rentee's equity book, not the company's ledger — so it is its
    //    own write, and it is not part of the invoice transaction above.
    if (raw.type === 'rtb' && raw.option_credit_weekly_pence != null) {
      const weeklyCredit = Number(raw.option_credit_weekly_pence);
      const deposit = Number(raw.deposit_pence);
      for (let week = 1; week <= currentWeek; week++) {
        const periodStart = addDays(startDate, (week - 1) * 7);
        const periodEnd = addDays(periodStart, 6);
        const eq = rtbEquityAtWeek(
          week,
          weeklyCredit,
          deposit,
          0, // list value only feeds pctOfVehicle, which we don't persist
        );
        const inserted = (await sql`
          insert into public.rtb_equity_ledger
            (tenant_id, agreement_id, week_no, credit_pence, cumulative_credit_pence,
             deposit_pence, equity_total_pence, as_of)
          values (${raw.tenant_id}::uuid, ${raw.id}::uuid, ${week},
                  ${raw.option_credit_weekly_pence}, ${eq.cumulativeCreditPence},
                  ${raw.deposit_pence}, ${eq.equityTotalPence}, ${periodEnd}::date)
          on conflict (agreement_id, week_no) do nothing
          returning id
        `) as Array<{ id: string }>;
        if (inserted.length) equityRows++;
      }
    }
  }

  const body = {
    ok: failures.length === 0,
    ran_on: today,
    rent_schedule_created: rentRows,
    invoices_created: invoices,
    journal_entries_posted: posted,
    equity_rows_created: equityRows,
    failures,
  };

  // A week that could not be billed is a loud failure, not a quiet one: the
  // rent for that week has not been invoiced, and the operator has to know
  // before the money is not there.
  return NextResponse.json(body, { status: failures.length === 0 ? 200 : 500 });
}
