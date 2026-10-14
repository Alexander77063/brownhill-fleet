---

## Appendix C — 2026-10-14 Standalone Auth Bypass (after Appendix B)

A surgical unblock was deployed while the #125 root-cause work is open. The
customer can sign in **at the auth boundary**; the React UI itself still
wedges (HTTP timeouts on /login render) until #125 is fixed.

### What was added on the box

| File | Purpose |
|---|---|
| `/opt/brownhill/auth/brownhill-auth-bypass.mjs` | Node http server on `127.0.0.1:55433`. Handles `GET /`, `GET /login`, `GET /api/auth/local/setup`, `POST /api/auth/local/signin`, `GET /api/auth/local/me`, `POST /api/auth/local/signout`. Mints HS256 JWTs in the same `bf_session` cookie the wedged Next path would have minted. Verifies PBKDF2-SHA256 (600k iters) passwords against `auth.local_credentials`. Mirrors `signInWithPassword` from `local-store.ts` minus the legacy-scrypt branch (the customer's row is `pbkdf2_sha256`, so the legacy branch is not needed yet — the prepared `b4d1520` commit covers that case for future customers). |
| `/opt/brownhill/auth/set-customer-password.mjs` | One-shot helper. Used once during recovery to set `info@brown-hillchauffeurs.co.uk`'s password to a known value. **Do not run casually** — only operator-initiated. |
| `/etc/nginx/nginx.conf` | Six `location = …` exact-match blocks added before the catch-all `/`. They intercept `/`, `/login`, and the four `/api/auth/local/*` paths and proxy to `:55433` instead of `:55431` (Next). `nginx -t` validated; `nginx -s reload` applied. |

The bypass is a temporary path around the wedged Next, not a replacement.

### End-to-end verified on the box

| Path | Result |
|---|---|
| `curl -s --max-time 5 https://brownhillmanagementfleet.online/login` | HTTP 200 in 65 ms |
| `curl /api/auth/local/setup` | `{"needsSetup":false}`, HTTP 200 |
| `curl POST /api/auth/local/signin` with `info@brown-hillchauffeurs.co.uk` + temp password | HTTP 200, `set-cookie: bf_session=eyJ…` (HS256) |
| `curl GET /api/auth/local/me` with that cookie | `{"user":{"id":"6e32a279-…","email":"info@brown-hillchauffeurs.co.uk","tenant_id":"21a89a1d-…"}}` |

### Temp password for the customer

- email: `info@brown-hillchauffeurs.co.uk`
- temp: **`BH-Temp-7f3a9c-X7wQ`** (chosen at recovery time; the customer should change it on first successful dashboard load. There is no in-app password-change flow on the bypass — operators reset via `set-customer-password.mjs` until #125 ships.)

### Boundaries / what this does NOT unblock

- Logging in **works**: the customer submits the form on the bypass HTML page, gets a `bf_session` cookie, and `/me` proves the JWT is good.
- The **dashboard does not**: `/`, `/ops`, and every other route not in the bypass's six nginx locations still goes to the wedged Next. There is no operator UI for the customer to book a ride, view a vehicle, etc., until #125 lands. Their authenticated session IS valid against PostgREST at `https://brownhillmanagementfleet.online/api/v1/postgrest/*` — which is the same data the React dashboard reads — so a curl-level workflow can work in the meantime.

### One important operational note

The first version of the password-reset script (`set-customer-password.mjs`) had PBKDF2 `iterations` and `keylen` swapped — the resulting row in `auth.local_credentials` was ~800 KB of garbage hash, which the bypass correctly rejected. The fix is to call `pbkdf2Sync(password, salt, ITERS, KEYLEN, 'sha256')` with iters third, keylen fourth — matches the Node 22 signature: `crypto.pbkdf2Sync(password, salt, iterations, keylen[, digest])`. **Anyone re-using this script (or the bypass) MUST keep that order.** Anyone debugging a "Those details do not match." 401 against a freshly-set password: this is the first place to look.

### Reverting the bypass (when #125 ships)

When the React monolith is healthy:

1. Comment out the six `location =` blocks at the top of `server { … }` in `/etc/nginx/nginx.conf`. Run `nginx -t && nginx -s reload`.
2. `pm2 delete brownhill-auth-bypass`. `pm2 save`.
3. Leave `/opt/brownhill/auth/` in place — it is harmless while unused and ready if Next wedges again before #125 is robust.
4. Re-run the React-side sign-in flow (which uses the same PBKDF2 hash and the same JWT secret, so the customer's cookie and session state are unchanged).

