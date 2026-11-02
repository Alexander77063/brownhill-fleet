#!/usr/bin/env node
// hosted/scripts/brownhill-cron.mjs
//
// Call one of the application's cron endpoints on this box.
//
// WHY THIS EXISTS
// ---------------
// On the SaaS the scheduled jobs are run by Vercel Cron: vercel.json names
// the path and the schedule, and Vercel calls it with
// `Authorization: Bearer $CRON_SECRET`. The hosted box has no Vercel — and
// until now it had no replacement either, so nothing called them at all.
//
// That is not a cosmetic gap. `/api/cron/generate-rent` is what raises the
// weekly rent invoice, and `/api/cron/complete-agreements` is what stops a
// finished agreement being billed for another week. With neither running,
// Brownhill's books stay empty: no invoice, no revenue in the ledger, no VAT
// on the return, nothing ageing on the receivables — and an agreement that
// has ended keeps billing.
//
// The systemd timers in hosted/systemd/ call this script, one per job, on the
// schedule vercel.json declares. This script is the caller, and it is
// deliberately the ONLY thing on the box that knows how to present the
// secret.
//
// WHY IT IS NODE AND NOT CURL
// ---------------------------
// The box's runtime is pinned and installed before the app is deployed
// (hosted/scripts/fetch-runtime.sh), and the app itself runs on it
// (/opt/brownhill/node/bin/node server.js). curl is not something the
// installer puts on the box, so a script that assumed curl would fail on a
// box the installer had just finished building. This script uses nothing but
// node's own http module, so there is nothing to install and nothing that
// can be missing.
//
// WHAT IT DOES
// ------------
// 1. Refuses to run without CRON_SECRET. The secret is the only thing
//    standing between the internet and the job that raises invoices, so a
//    missing secret is a REFUSAL, not a default.
// 2. Calls the endpoint on the loopback address with the bearer token.
// 3. Prints the status and the body, so the journal says what happened.
// 4. Exits non-zero on a failure, so `systemctl status brownhill-cron@…`
//    shows a failed unit rather than a green one that did nothing.

import http from 'node:http';
import https from 'node:https';

const slug = process.argv[2];
const base = (process.env.CRON_BASE_URL || 'http://127.0.0.1:55431').replace(/\/+$/, '');
const secret = process.env.CRON_SECRET || '';
const timeoutMs = Number(process.env.CRON_TIMEOUT_MS || 240000);

/** Print a reason and stop. A refusal is not a crash. */
function refuse(reason) {
  process.stderr.write(`brownhill-cron: ${reason}\n`);
  process.exit(1);
}

if (!slug) refuse('usage: brownhill-cron.mjs <cron-slug>');

// The slug comes from the systemd unit, so it is not attacker-controlled.
// It is checked anyway: this script is on the box with a secret in its
// environment, and the cheapest way to be sure it can only ever reach
// /api/cron/<slug> is to refuse anything that is not a slug.
if (!/^[a-z0-9-]+$/.test(slug)) {
  refuse(`refusing to call "${slug}": a cron slug is lower-case letters, digits and dashes`);
}

if (!secret) {
  refuse(
    'CRON_SECRET is not set. The cron endpoints reject every call without it, ' +
      'so running anyway would only produce a 401 in the journal.',
  );
}

const url = new URL(`${base}/api/cron/${slug}`);
const transport = url.protocol === 'https:' ? https : http;

const request = transport.request(
  url,
  {
    method: 'GET',
    headers: {
      authorization: `Bearer ${secret}`,
      accept: 'application/json',
      'user-agent': 'brownhill-cron/1',
    },
    timeout: timeoutMs,
  },
  (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const status = response.statusCode ?? 0;
      process.stdout.write(
        `brownhill-cron: ${slug} -> HTTP ${status} ${response.statusMessage ?? ''}\n`,
      );
      if (body) process.stdout.write(`${body}\n`);

      if (status < 200 || status >= 300) {
        process.stderr.write(`brownhill-cron: ${slug} failed with HTTP ${status}\n`);
        process.exit(1);
      }
      process.exit(0);
    });
  },
);

request.on('timeout', () => {
  request.destroy();
  refuse(`${slug} did not answer within ${timeoutMs}ms`);
});

request.on('error', (error) => {
  refuse(`${slug} could not be reached at ${url.origin}: ${error.message}`);
});

request.end();
