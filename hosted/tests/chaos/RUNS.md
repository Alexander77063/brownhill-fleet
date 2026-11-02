# Chaos drill RUNS

Each row is one drill, run by Alex at least monthly. Aim: prove the
hosted stack fails closed and recovers automatically on the failure
modes that the spec promises it does.

**Every row below records what was actually run, against what, and how
many assertions it made.** A drill that has never been run is not a
drill; it is a file. The rows that have not been run say so, and say
why — the point of this table is that it cannot be mistaken for a claim
nobody checked.

## Why the assertion counts moved on 2026-11-02

Every drill begins by calling `drill_setup`, which sweeps the debris of
any earlier drill that was killed before it could clean up after
itself. That sweep used to **assert only when it found something** —
so the drill's assertion count depended on what the database happened
to hold when the drill started. The same drill, on a clean database and
on a dirty one, reported two different numbers, and a number that moves
on its own is a number the handover cannot publish.

The sweep now asserts **unconditionally**: the branch that had
leftovers to remove says so, and the branch that found nothing says
that too. The count is the same on every run, and what the run proves is
the same on every run — the debris is gone. Every count below is the
measured number on 2026-11-02, after that change, and each one is
higher than the previous figure by exactly one.

## 2026-11-02

Against the compose stack (`hosted/dev/docker-compose.yml`) — the same
Postgres, PostgREST and Next the deployment runs, with the real
migrations applied.

- [x] **01-power-loss.sh** — PASS, 12 assertions. The database was
      killed with SIGKILL and was gone; it came back in **8s** (budget
      60s); the vehicle, the invoice and the agreement count were
      unchanged; `pg_is_in_recovery()` was false; the RLS proof passed
      (14 checks); the application answered again.
- [x] **02-postgres-restart.sh** — PASS, 12 assertions. The database was
      restarted and was back in **6s** (budget 30s); the application was
      serving; the data plane answered again with the same session, and
      returned this drill's own row; the rows were intact; the RLS proof
      passed (14 checks).
- [x] **05-vat-submit-rejected.sh** — PASS, 16 assertions. HMRC refused
      the return, the refusal was recorded with HMRC's own words, and
      nothing was posted to the ledger.
- [x] **06-period-close-with-open-bank.sh** — PASS, 22 assertions. The
      close warned, refused a close nobody had confirmed, closed only on
      a confirmation carrying the figures that were shown, and the closed
      month refused a posting without writing anything.
- [x] **07-mid-period-void.sh** — PASS, 35 assertions. The box raised
      the rent invoice by itself, the invoice was dated to the week it
      bills and posted to the ledger, the operator cancelled it over
      HTTP, the reversal landed in the invoice's own month alongside the
      postings already there, it was the mirror of the original, money
      already received became a refund owed, and a second void was
      refused without writing anything.
- [x] **08-concurrent-period-close.sh** — PASS, 13 assertions. One of
      two operators closing the same month at the same instant closed
      it; the other was told who won and when.
- [x] **09-mtd-token-expiry.sh** — PASS, 22 assertions. An expired
      token was renewed and the return filed; a token that could not be
      renewed produced a reconnection request and no posting at all.
- [ ] **03-corrupt-dump-rejected.sh** — NOT RUN HERE. It needs the box's
      own `/usr/local/bin/restore.sh`, root, and the box's own
      `app_state` — it exercises the deployed box's restore console, not
      a fault in the product. Run it on the box.
- [ ] **04-b2-sync-stale.sh** — NOT RUN HERE. It needs the box's own
      `/usr/local/bin/b2` and the `alert-watch.path` unit. Run it on
      the box.

**Not yet run on the box.** Every row above was run against the compose
stack. The two rows marked "NOT RUN HERE" have never been run at all —
on the stack or on the box — and they are the two that need the box.

## The gates that carry the handover

These are not drills — they are the gates CI runs on every change, and
they are recorded here because they are the things the handover depends
on being true.

- [x] **hosted/tests/smoke/authenticated-round-trip.sh** — PASS, 11
      assertions. An operator signs in with a password, is refused with a
      wrong one (401, without saying which half was wrong), is let into
      the operations desk and the data plane behind their session, and is
      not locked out by the mistake.
- [x] **hosted/tests/fixture-isolation.sh** — PASS, 12 assertions. Two
      fixtures stood side by side and neither could see the other, and
      neither left anything behind.
- [x] **hosted/tests/fixture-isolation-negative.sh** — PASS, 6
      assertions. The isolation gate fails when the fixture's join loses
      its tenant filter — and fails with the duplicate-invoice symptom
      of that defect, not some unrelated error.
- [x] **hosted/tests/drill-stamp-uniqueness.sh** — PASS, 27 assertions.
      Two fixtures built in the same second cannot share a stamp, because
      a stamp is derived from the row's own uuid rather than from the
      clock and the process id. The clock is frozen while the gate runs,
      so the collision is guaranteed rather than likely — and every
      fixture that mints a stamp (the drills, the isolation gate, the
      round trip and the handover journey) derives it from the row's own
      id and puts it into the unique columns it is there to protect. The
      gate was proved to bite: putting the old clock-and-pid stamp back
      into the round trip fails it in two independent places.
- [x] **hosted/tests/journey/operator-journey.sh** — PASS, 70 assertions.
      The operator signed in, every operations, admin and accounting page
      answered with their own rows in them, another tenant saw none of
      it, and the accounting module billed rent, took the money, read the
      books back and cancelled a mis-billed invoice.
- [x] **hosted/tests/accounting/accounting-smoke.sh** — PASS, 24
      assertions. It is the last part of the journey above, run on its
      own.
- [x] **hosted/tests/cron-timers.sh** — PASS, 48 assertions. Every
      application cron has a timer and every timer has a route, the
      schedule in `vercel.json` and the schedule on the box agree, the
      shared secret is provisioned and loaded by both the application and
      the timer, the caller refuses to run without a secret, refuses a
      slug that is not a slug, calls the right path with the right header
      and fails loudly when the endpoint fails, and every `OnCalendar`
      expression parses.
- [x] **hosted/tests/cron-timers-negative.sh** — PASS, 6 assertions. The
      timer gate fails when a timer is removed from the box — because a
      gate that cannot fail is not a gate, and this one is what stops the
      box quietly going back to billing nobody.
