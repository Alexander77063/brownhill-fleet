---

## Appendix C — 2026-10-14 Standalone Auth Bypass (after Appendix B)

A surgical unblock was deployed while the #125 root-cause work is open. The
customer can sign in **at the auth boundary**; the React UI itself still
wedges (HTTP timeouts on /login render) until #125 is fixed.

### What was added on the box

| File | Purpose |
|---|---|
| `/opt/brownhill/auth/brownhill-auth-bypass.mjs` | Node http server on `127.0.0.1:55433`. Handles `GET /`, `GET /login`, `GET /api/auth/local/setup`, `POST /api/auth/local/signin`, `GET /api/auth/local/me`, `POST /api/auth/local/signout`. Mints HS256 JWTs in the same `bf_session` cookie the wedged Next path would have minted. Verifies PBKDF2-SHA256 (600k iters) passwords against `auth.local_credentials`. Mirrors `signInWithPassword` from `local-store.ts` minus the legacy-scrypt branch (the customer's row is `pbkdf2_sha256`, so the legacy branch is not needed yet — the prepared `b4d1520` commit covers that case for future customers). **Self-contained by design** — it imports nothing, so a box with only this file still signs the customer in. |
| `/opt/brownhill/auth/set-customer-password.mjs` | One-shot helper. Used once during recovery to set `info@brown-hillchauffeurs.co.uk`'s password to a known value. **Do not run casually** — only operator-initiated. |
| `/opt/brownhill/auth/auth-crypt.mjs` | The PBKDF2 the operator scripts share. `set-customer-password.mjs` imports it, so **the two files must be copied to the box together** — the script fails immediately, loudly, if its import is missing. It holds no secret and no credential. |
| `/etc/nginx/nginx.conf` | Six `location = …` exact-match blocks added before the catch-all `/`. They intercept `/`, `/login`, and the four `/api/auth/local/*` paths and proxy to `:55433` instead of `:55431` (Next). `nginx -t` validated; `nginx -s reload` applied. |

The bypass is a temporary path around the wedged Next, not a replacement.

### End-to-end verified on the box

| Path | Result |
|---|---|
| `curl -s --max-time 5 https://brownhillmanagementfleet.online/login` | HTTP 200 in 65 ms |
| `curl /api/auth/local/setup` | `{"needsSetup":false}`, HTTP 200 |
| `curl POST /api/auth/local/signin` with `info@brown-hillchauffeurs.co.uk` + temp password | HTTP 200, `set-cookie: bf_session=eyJ…` (HS256) |
| `curl GET /api/auth/local/me` with that cookie | `{"user":{"id":"6e32a279-…","email":"info@brown-hillchauffeurs.co.uk","tenant_id":"21a89a1d-…"}}` |

### The customer's temporary password — ROTATE IT

- email: `info@brown-hillchauffeurs.co.uk`
- A temporary password was issued during this recovery. **Its value is not in this
  document, and it must not be put back.** It was printed here while this
  repository was public, so it has to be treated as compromised: deleting the
  line does not remove it from the history, and the history is public.
- There is no in-app password-change flow on the bypass, so the customer cannot
  change it themselves — operators reset it with `set-customer-password.mjs`,
  and the new value goes to the customer out of band (a phone call, not an
  email, and never a file in this repository).
- The rotation is listed in `HANDOFF-BROWNHILL.md` under **Rotation required
  before handover**. Do it before the customer next signs in.

### Boundaries / what this does NOT unblock

- Logging in **works**: the customer submits the form on the bypass HTML page, gets a `bf_session` cookie, and `/me` proves the JWT is good.
- The **dashboard does not**: `/`, `/ops`, and every other route not in the bypass's six nginx locations still goes to the wedged Next. There is no operator UI for the customer to book a ride, view a vehicle, etc., until #125 lands. Their authenticated session IS valid against PostgREST at `https://brownhillmanagementfleet.online/api/v1/postgrest/*` — which is the same data the React dashboard reads — so a curl-level workflow can work in the meantime.

### One important operational note

PBKDF2's signature is `crypto.pbkdf2Sync(password, salt, iterations, keylen, digest)` — iterations THIRD, keylen FOURTH. Swap them and nothing throws: it silently derives a key of the wrong length. The first version of `set-customer-password.mjs` had them swapped, and the row it wrote was ~800 KB of garbage that the bypass correctly rejected.

The maths now lives in ONE place — `auth-crypt.mjs` — and the operator scripts import it, so there is no second copy to get wrong. `tests/unit/auth-tooling.test.ts` pins the order for every `pbkdf2Sync` call in the tree, and pins that a row the scripts write is a row the app's own verifier accepts.

The auth bypass is the deliberate exception: it keeps its own copy of the maths and keeps NO way to write a hash. It is copied to the box as a single file and is the customer's way back in when Next.js is wedged, so a box updated with one file but not the other would have no way to sign the customer in at all. Resetting a password is `set-customer-password.mjs`'s job — one script, not two.

**If you re-use any of it, keep the order.** Anyone debugging a "Those details do not match." 401 against a freshly-set password: this is the first place to look.

### Reverting the bypass (when #125 ships)

When the React monolith is healthy:

1. Comment out the six `location =` blocks at the top of `server { … }` in `/etc/nginx/nginx.conf`. Run `nginx -t && nginx -s reload`.
2. `pm2 delete brownhill-auth-bypass`. `pm2 save`.
3. Leave `/opt/brownhill/auth/` in place — it is harmless while unused and ready if Next wedges again before #125 is robust.
4. Re-run the React-side sign-in flow (which uses the same PBKDF2 hash and the same JWT secret, so the customer's cookie and session state are unchanged).

