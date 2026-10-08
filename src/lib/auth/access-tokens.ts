// src/lib/auth/access-tokens.ts
// Access + refresh JWT pair issuance for the hosted profile.
//
// The brief's plan (PR #79 deviation 5) used issueSessionToken — a session cookie —
// which works for the standalone desktop app where the Next app runs in a single
// process on the same Windows machine as the operator. That doesn't fit the hosted
// profile: browsers explicitly need Bearer tokens (cookies over HTTPS are fine but
// tie issuance to a specific browser and gate cross-tab scenarios). So we replace
// the bootstrap's session-cookie mint with a short-lived access token + a
// long-lived refresh token. PostgREST validates the access token against the same
// per-install secret; the refresh token is rotated on /auth/refresh (PR #80 wires
// a refresh endpoint, but the rotation itself is out of scope here).
//
// The secret is read from /etc/brownhill/secrets/jwt.env on each call, so secret
// rotation between deploys is honoured without restarting the app.

import { readFileSync } from 'node:fs';
import { signJwt, type JwtClaims } from './jwt';

const ACCESS_TTL_SECONDS  = 5 * 60;        // 5 minutes
const REFRESH_TTL_SECONDS = 30 * 24 * 3600; // 30 days

const JWT_SECRET_PATH = '/etc/brownhill/secrets/jwt.env';

function readSecret(): string {
  const raw = readFileSync(JWT_SECRET_PATH, 'utf8');
  const m = raw.match(/^JWT_SHARED_SECRET=(.+)$/m);
  if (!m) throw new Error(`No JWT_SHARED_SECRET in ${JWT_SECRET_PATH}`);
  return m[1].trim();
}

export interface IssueClaims {
  sub: string;             // user id
  role: 'authenticated';    // bootstrap is always owner-tier → authenticated after RLS
  tenant_id: string;
  email: string;
}

export interface AccessPair {
  access: string;
  refresh: string;
  /** Unix seconds when the pair was issued. iat is also embedded in each JWT. */
  iat: number;
}

export interface IssueOpts {
  /** Override the per-install JWT secret (e.g. for tests). Default: read from
   * `/etc/brownhill/secrets/jwt.env` on each call. */
  secret?: string;
}

/**
 * Mint a short-lived access JWT and a longer-lived refresh JWT.
 *
 * Both tokens carry the same claims (subject, role, tenant_id, email); the refresh
 * token is differentiated by a longer exp. The middleware does not yet distinguish
 * them — that lands with the /auth/refresh work in PR #80; for v1 the hosted
 * client refreshes by re-presenting the refresh token in the Authorization
 * header to /auth/refresh.
 */
export async function issueAccessPair(claims: IssueClaims, opts: IssueOpts = {}): Promise<AccessPair> {
  const secret = opts.secret ?? readSecret();
  const now = Math.floor(Date.now() / 1000);
  const base: Omit<JwtClaims, 'iat' | 'exp'> = {
    sub: claims.sub,
    role: claims.role,
    tenant_id: claims.tenant_id,
    email: claims.email,
  };
  // The two tokens are the same claims; the only difference is exp. iat is
  // emitted by signJwt itself, so refreshing on the client presents a new token
  // with a fresh iat and a new exp window.
  const access  = await signJwt(base, secret, ACCESS_TTL_SECONDS);
  const refresh = await signJwt(base, secret, REFRESH_TTL_SECONDS);
  return { access, refresh, iat: now };
}
