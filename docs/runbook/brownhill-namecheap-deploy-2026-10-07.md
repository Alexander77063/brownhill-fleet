# Brownhill Hosted — Namecheap Pulsar Deploy State

> Snapshot of a single deploy attempt, 2026-10-07 / 2026-10-08. This doc captures
> what is live on the box, what is deliberately skipped, what files were patched,
> and the exact steps the next operator needs to finish the install. It is **not**
> a runbook — it is a checkpoint for the next session after upstream issues
> #108 through #115 are patched.

## Box

- Host: Namecheap Business VPS Pulsar
- Tier: Quasar (4 vCPU / 6 GB RAM / 120 GB SSD)
- OS: Ubuntu 24.04.5 LTS
- Public IP: 104.207.83.238
- Region: **Los Angeles, California, US** — operator chose this with eyes open. 80 to 120 ms latency for a UK customer; UK GDPR data residency needs SCCs plus a transfer risk assessment (already on punch-list).
- Hostname: server1.brownhillmanagementfleet.online
- FQDN: brownhillmanagementfleet.online (and www.)
- SSH: publickey-only — green check when `ssh root@104.207.83.238` accepts the operator ed25519 key from their laptop
- Old temp password (Namecheap welcome email): rotated to a 32-char random on first login; the new value lives in /etc/brownhill/secrets/pg.env (mode 0640, postgres-owned). The temp value no longer works.

## State of the deploy

### Working (verified)

- DNS: both @ and www.brownhillmanagementfleet.online resolve to 104.207.83.238 via 8.8.8.8 / 1.1.1.1 / 208.67.222.222. Namecheap internal DNS (100.100.100.16) still serves the parking IP for @ — overridden locally via systemd-resolved per-link (DNS=8.8.8.8 1.1.1.1, [DHCP] UseDNS=no). Both A records are in the Namecheap panel; the old CNAME for www and URL-redirect for @ are removed.
- Secrets on the box (mode 0640, postgres- or root-owned per HANDOFF §3): /etc/brownhill/secrets/{pg,jwt,bootstrap,backup,resend}.env. Not duplicated in this doc.
- Postgres 16.15 running via pg_ctl (NOT via systemd — see Skipped). Listens on 127.0.0.1:55432, Unix socket at /var/run/postgresql/.s.PGSQL.55432. Data directory has data_checksums off (apt initdb default). pg_hba.conf requires md5 from 127.0.0.1.
- Schema applied: 94 tables in public, storage, auth. Migrations 0064 to 0071 (accounting) explicitly skipped in /usr/local/bin/brownhill-bootstrap.sh via a regex filter that excludes accounting files. This is a permanent patch on the box — **and it is now obsolete**: the migration ledger records what has been applied, so the filter is replaced by a recorded `--skip` list. See "Adopting this box into the migration ledger" below.
- PostgREST 12.2.3 running as postgrest.service (systemd-managed, port 55430, bound to 127.0.0.1). Connected to Postgres; app_state.bootstrap_pending=1 so the operator-bootstrap endpoint will serve.
- B2 / Resend / postgres superuser credentials seeded and reachable.
- Mirror HEAD: 99e170e at /opt/brownhill/repo.

### Skipped / broken

- postgresql.service systemd unit is broken — in-repo hosted/systemd/postgresql.service has --data-checksums without a value (rejected by Postgres 16, issue #110). Postgres runs via manual pg_ctl. If the box is rebooted, bring Postgres up via the pg_ctl command above. Long-term fix: replace the unit and `systemctl enable --now postgresql`.
- Accounting migrations (0064 to 0071) skipped — three real upstream bugs (issues #111, #112, #113). Accounting module is disabled for this deploy anyway.
- Next.js build does not compile. Two architectural blockers:
  - src/lib/auth/password.ts uses node:crypto (scrypt, randomBytes, timingSafeEqual) which Webpack 5 / Next 15 cannot bundle for Edge runtime. Issue #114 has the proposed fix (Web Crypto, PBKDF2-SHA256, 600k iterations, self-describing hash format).
  - src/middleware.ts imports localDb from src/lib/auth/local-store.ts, which transitively imports the Node-only postgres package. Issue #115 has the proposed fix. Operator has done half: created src/lib/db/local.ts and updated middleware.ts. Leftover work: delete localDb (and let cached / type Sql) from local-store.ts.
- coa-custom.ts had 24 broken lines (missing normal_balance keys). Fixed in-repo via regex substitution.

### Files modified on the box (not in any PR)

| File | Change | Why |
|---|---|---|
| /usr/local/bin/brownhill-bootstrap.sh | repo path calc fixed (was resolving to /), plus a filter that skips accounting migrations | install.sh repo path calc is wrong; accounting migrations have upstream bugs. **Both patches are obsolete** — the repository's copy fixes the path calculation, and the ledger does the skipping properly. See "Adopting this box into the migration ledger". |
| /etc/systemd/system/postgresql.service | rewritten without --data-checksums and -c unix_socket_directories (still failing for other reasons, see #110) | Postgres 16 rejects the bad flags |
| /etc/systemd/resolved.conf | DNS=8.8.8.8 1.1.1.1, [DHCP] UseDNS=no | box per-link Namecheap internal DNS lags for @ |
| /var/lib/postgresql/16/main/postgresql.conf | listen + port + unix_socket_directories; data_checksums off | data dir from apt with data_checksums off |
| /var/lib/postgresql/16/main/pg_hba.conf | rewritten: peer for local socket, md5 for 127.0.0.1 | bootstrap.sh needs md5 auth |
| src/lib/auth/local-store.ts | import server-only added at top | keeps it out of edge bundles |
| src/lib/auth/password.ts | import server-only added at top | partial fix for node:crypto |
| src/lib/accounting/nigeria/coa-custom.ts | 24 lines fixed via regex | build was failing on type error |
| src/lib/db/local.ts | NEW file — minimal localDb() helper, dynamic-imports postgres | part of #115 fix |
| src/middleware.ts | imports localDb from @/lib/db/local | part of #115 fix |
| next.config.ts | added NodePolyfillPlugin to webpack | partial fix for node:crypto |
| package.json | sharp@0.32 pinned, server-only + node-polyfill-webpack-plugin added | QEMU CPU lacks v2 microarchitecture — sharp 0.32 from source works |

## Issues filed

- #108 install.sh missing mkdir for postgresql.service.d drop-in directory
- #109 install-postgrest-conf.sh envsubst does not substitute secrets
- #110 hosted/systemd/postgresql.service --data-checksums flag rejected by Postgres 16
- #111 supabase/migrations/0064 invalid DEFERRABLE clause on CREATE TRIGGER
- #112 supabase/migrations/0068 COALESCE type mismatch text vs uuid
- #113 supabase/migrations/0001 non-idempotent CREATE TYPE blocks re-bootstrap
- #114 src/lib/auth/password.ts uses node:crypto, breaks Edge-runtime bundle (TO FILE)
- #115 src/middleware.ts imports localDb via local-store.ts which transitively pulls in postgres Node-only driver (TO FILE)

## Adopting this box into the migration ledger

The schema on this box was applied by hand before the migration ledger existed,
and the bootstrap script on the box carries two local patches (see the table
above): a corrected repository-path calculation, and a regex filter that skips
the accounting migrations 0064–0071.

Both are obsolete now, and the second one is actively harmful. The ledger
records what has been applied, so the bootstrap applies only what is missing —
which is what the regex filter was working around, badly. The filtered
migrations were never recorded either, so the filter had to be kept on the box
forever or the schema and the history drifted apart. The ledger records a skip
as a skip, so the filter is no longer needed to protect anything.

**1. Replace the patched script with the repository's copy.** `install.sh`
installs the units and the scripts, so re-running it replaces both local
patches:

```bash
cd /opt/brownhill/repo && git pull
sudo ./hosted/bootstrap/install.sh
```

**2. Ask the ledger what it sees.** This does not change the application's
schema — it is a report. (It does create the empty ledger table if that is not
there yet, because that table is what it reads.)

```bash
sudo -u postgres /usr/local/bin/brownhill-bootstrap.sh --status
```

It names every migration and its state, and ends with the cut to use:

```
MIGRATION                                                 STATE
0001_extensions.sql                                       present, not recorded (provisioned before the ledger)
...
0063_hardware_operations.sql                              present, not recorded (provisioned before the ledger)
0064_accounting_schema.sql                                absent
...
The first migration that is NOT in the database is 0064_accounting_schema.sql.
Everything before it is. Adopt the database with:
  --baseline-through=0063_hardware_operations.sql
    (this records everything up to and including 0063_hardware_operations.sql as
     applied; 0064_accounting_schema.sql and everything after it are applied normally)
```

**3. Adopt the database.** `--baseline-through=FILE` claims FILE and every
migration before it — so on this box that is 0001 through 0063, which is
exactly what is there:

```bash
sudo -u postgres /usr/local/bin/brownhill-bootstrap.sh \
  --baseline-through=0063_hardware_operations.sql
```

The claim is checked against the database — every table, enum type and function
those migrations create has to actually be there — and the run is **refused** if
it is not. A baseline that over-claims is refused rather than applied, and the
refusal names what is missing.

The check happens **before anything is written**, so a refusal leaves the
database exactly as it was — nothing applied, nothing recorded. If the cut is
wrong, read the refusal and try a different one; the box is unchanged
between attempts.

**4. The accounting migrations.** They were skipped for three upstream bugs
(#111, #112 and #113). #113 is fixed by the ledger itself — the non-idempotent
`create type` in 0001 was the reason the bootstrap could not be re-run at all.
#111 and #112 were fixed in the repository: 0064 now creates a *constraint*
trigger (Postgres only accepts `DEFERRABLE` on one) and 0068 casts the uuid
inside the coalesce. So the skip is no longer forced on this deployment.

Try it without the skip first — that is the state to be in:

```bash
sudo -u postgres /usr/local/bin/brownhill-bootstrap.sh \
  --baseline-through=0063_hardware_operations.sql
```

If the accounting module is still deliberately off for this deployment, skip
the eight files explicitly. A skip is recorded in the ledger as `skipped`, so
it is a decision on the record rather than a local patch nobody can see:

```bash
sudo -u postgres /usr/local/bin/brownhill-bootstrap.sh \
  --baseline-through=0063_hardware_operations.sql \
  --skip=0064_accounting_schema.sql,0065_accounting_coa_seed.sql,0066_accounting_vat_codes_seed.sql,0067_accounting_billing_extensions.sql,0068_accounting_rls.sql,0069_accounting_nigeria_tenant_scoping.sql,0070_accounting_reopen_window_per_tenant.sql,0071_accounting_per_tenant_thresholds.sql
```

**5. Make a deliberate skip permanent** — as a systemd drop-in, so it survives
a reboot and is visible in the unit rather than in a patched script:

```bash
sudo systemctl edit brownhill-bootstrap.service
# [Service]
# Environment=BROWNHILL_SKIP_MIGRATIONS=0064_accounting_schema.sql,0065_accounting_coa_seed.sql,0066_accounting_vat_codes_seed.sql,0067_accounting_billing_extensions.sql,0068_accounting_rls.sql,0069_accounting_nigeria_tenant_scoping.sql,0070_accounting_reopen_window_per_tenant.sql,0071_accounting_per_tenant_thresholds.sql
```

**6. Take the baseline out of the drop-in.** The baseline is a one-off
adoption, not a setting: once the ledger holds the history, the cut is no
longer needed and keeping it would re-assert a claim every boot.

```bash
sudo systemctl revert brownhill-bootstrap.service   # or edit the drop-in away
sudo systemctl restart brownhill-bootstrap.service
sudo journalctl -u brownhill-bootstrap.service --since '1 minute ago' --no-pager
```

The last line must read `applied 0 migrations`. If it does, the box is
idempotent: every reboot from now on is a no-op that exits 0.

## Next operator checklist

1. ~~Wait for issues #114 and #115 to be patched upstream.~~ **Done** — both blockers were fixed in the repository, not upstream: `src/lib/auth/password.ts` now uses Web Crypto (PBKDF2-HMAC-SHA256) instead of `node:crypto`'s scrypt, and `src/lib/db/local.ts` replaced the Node-only `localDb` import in `src/middleware.ts`. The build in step 6 is the confirmation.
2. SSH in as root with the operator ed25519 key.
3. Bring Postgres up if down: `sudo -u postgres /opt/brownhill/pgsql/bin/pg_ctl -D /var/lib/postgresql/16/main -l /tmp/pglog.txt start`.
4. Verify PostgREST: `systemctl status postgrest`.
5. **Adopt the box's schema into the migration ledger** — see "Adopting this box into the migration ledger" above. Do this before the app is deployed: until the database is adopted, the bootstrap cannot record what it has applied, and the box's own patched script is still the one doing the work.
6. Build: `cd /opt/brownhill/repo && export PNPM_HOME=/root/.local/share/pnpm PATH=$PNPM_HOME:$PATH && DEPLOYMENT_PROFILE=hosted pnpm exec next build`.
7. Deploy to /var/lib/brownhill/app per HANDOFF §4 D.
8. Install brownhill-next.service: copy + `systemctl daemon-reload && systemctl enable --now brownhill-next`.
9. Configure nginx with the brownhill.conf template and substitute-fqdn.sh.
10. Issue cert via initial-cert.sh brownhillmanagementfleet.online ops@brownhillmanagementfleet.online. Verify with `curl -I https://brownhillmanagementfleet.online/`.
11. Run the 5-gate acceptance.sh. Gate 5 may need backup service touched manually (no Sunday yet).
12. Bootstrap owner (HMAC-signed POST to /api/v1/bootstrap).
13. Browser sign-in from laptop to /ops.

## Ops cadence

- Daily: zero (timers handle backup, verify, certbot renew)
- Monthly: chaos drills hosted/tests/chaos/0[1-4]-*.sh, log to RUNS.md
- Updates: `cd /opt/brownhill/repo && git pull && pnpm install --frozen-lockfile && pnpm build:hosted && systemctl restart brownhill-next postgrest`
- Alert paging: wire /usr/local/bin/brownhill-alert-forward.sh — currently an empty shim