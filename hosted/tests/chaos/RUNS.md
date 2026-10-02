# Chaos drill RUNS

Each row is one drill, run by Alex at least monthly. Aim: prove the
hosted stack fails closed and recovers automatically on the failure
modes that the spec promises it does.

## YYYY-MM-DD

- [ ] **01-power-loss.sh** — pass/fail, time to recover
- [ ] **02-postgres-restart.sh** — pass/fail, alert triggered?
- [ ] **03-mid-restore-crash.sh** — pass/fail, drain state retained?
- [ ] **04-b2-sync-stale.sh** — pass/fail, marker cleared after restore?
