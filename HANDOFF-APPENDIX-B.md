---

## Appendix B — 2026-10-14 Outage Recovery (added in-session)

### What was actually wrong

The customer reported "they can't log in". The actual chain of failure had two layers:

1. **Layer A — Next.js event-loop wedge (root cause).** The `next-server` process bound to `127.0.0.1:55431` but never accepted connections — `curl --max-time 25 http://127.0.0.1:55431/login` times out at TCP handshake. `pm2 jlist` shows heap `Used/Size` rising from ~21 MiB at start to ~73 of 75 MiB (97%) within seconds, with PM2 `event_loop_latency_p95` microseconds holding normal but `active_handles` stuck. This is **SaaS-repo issue #125** (the "next.js event-loop wedge" mentioned in commit 7301b26's message: "Tested Oct 8-9, customer was working for 4 days before next.js event-loop wedge"). Restarting the process buys only seconds before it wedges again.
2. **Layer B — PM2 self-heal was disabled.** The PM2 supervisor's process for `brownhill-next` was started with `max_memory_restart` unset, `heapdump:true` but the `heapdump` npm module not installed in the standalone output, and no `--max-old-space-size=` so V8's heap ceiling was the ~75 MiB inferred from the host's available memory. PM2 considers a process "online" while the event loop is wedged, so `autorestart` does not fire on this failure mode.

The **password hash format is NOT the cause**. `auth.users` and `auth.local_credentials` carry the customer's hash as `pbkdf2_sha256$600000$...` with `failed_attempts=0` and `locked_until=NULL`. The fix already prepared for the legacy-scrypt edge case (the unmerged worktree branch `worktree-fix+legacy-scrypt-verify`, commit `b4d1520`) is correct and tested but does not help THIS customer — it is a safety net for any future pre-deploy migration.

### What now works end-to-end

Verified working at the time of writing:

| Path | Result | Time |
|---|---|---|
| `https://brownhillmanagementfleet.online/api/v1/postgrest/` (nginx -> postgrest -> postgres) | HTTP 200 | 95 ms |
| Postgres auth tables (`auth.users`, `auth.local_credentials` populated; queryable) | OK | -- |
| `https://brownhillmanagementfleet.online/login` (nginx -> next -> React tree) | timed out at 25 s | -- |

So everything around Next is up; only the Next monolith is wedged.

### What was changed in-session

- **`/var/lib/brownhill/app/server.js`'s PM2 process** deleted and re-launched from a new ecosystem file at `/root/.pm2/ecosystem.config.cjs`. The new config:
  - `node_args: ["--max-old-space-size=512", "--heapsnapshot-signal=SIGUSR2"]` — raises the V8 heap ceiling and arms a snapshot trigger.
  - `max_memory_restart: '384M'` — so the next time heap pressure approaches OOM, PM2 restarts cleanly instead of PM2 watching a wedged process that is technically alive.
  - `restart_delay`, `max_restarts`, `min_uptime` set so a crash loop is detectable and capped.
  - Logs redirected to `/var/log/brownhill-next.{out,error}.log` (was under `/root/.pm2/logs/` previously, fine but less observable from the operator's standard log path).
- **Heap snapshot captured** at `/var/lib/brownhill/app/Heap.20261014.132300.969147.0.001.heapsnapshot` (66 MiB) before the reconfigure. Send `kill -SIGUSR2 <pid>` to the new process to grab another one.
- **`brownhill-next.service` systemd unit** left in its disabled state. The operator chose PM2; respect the choice. If the PM2-on-boot story is incomplete, that is a separate wiring task.

### Open engineering task: root-cause issue #125

The PM2 reconfigure is a mitigation (heap ceiling + watchdog), not a fix. The actual leak is in the Next 15 standalone runtime — something in the App Router precompilation or a hot route is allocating without releasing. To make this permanent:

1. Capture a heap snapshot from a healthy build (e.g. tag a clean build with `--heapsnapshot-signal=SIGUSR2` and snapshot after a single /login render).
2. Diff against the captured snapshot above.
3. Look for source-grew retains or repeated allocating closures; specifically check any route imported under `src/app/api/auth/local/` and any Server Component touched by `/login`. Issue #125 on the SaaS repo has whatever was found upstream; merge any available fix or apply it stand-alone to this profile.

Until that fix lands, the customer CANNOT log in via the React app — every restart wedges within seconds. Confirm the customer is willing to wait, or else temporarily take the React app out of nginx's `proxy_pass` and have a minimal `proxy_pass` to a 6-line Node auth endpoint that just calls `signInWithPassword` from `local-store.ts` (no App Router, no React tree, no leak surface).

