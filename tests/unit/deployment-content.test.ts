// tests/unit/deployment-content.test.ts
//
// WHAT THIS PINS
// --------------
// Six defects that a customer reads on a screen, or a browser answers 404 on.
// None of them crashes the application; all of them are the product telling a
// customer something untrue about itself — or about a document they are about
// to sign.
//
//   * The legal pages published a bracketed placeholder where a company
//     registration number belongs: "[company registration number]". A Terms
//     of Service that says "company number [company registration number]" is
//     not a document anybody can enter into.
//   * The legal pages published the PLATFORM's identity — the upstream SaaS
//     operator's name, email and website — on a box the customer operates.
//     On Brownhill's own server the privacy policy named a company that has
//     nothing to do with it.
//   * The accessibility statement named the Equality Advisory and Support
//     Service in EVERY region, including the one where the Equality Act 2010
//     does not apply.
//   * The HMRC redirect URI fell back to `http://localhost:3000`, so an
//     install with no NEXT_PUBLIC_APP_URL would register a callback address
//     that can never work — silently, and only discovered at the moment the
//     operator clicks "Connect to HMRC".
//   * The incident queue's "View photo" link pointed at the charge-media
//     route, which resolves `charge_media.id` — but the queue holds a
//     `driver_damage_reports.photo_path`, which is a storage path. Every
//     click was a 404.
//   * The billing page printed a cron command against a hardcoded domain, so
//     the copy on one box told an operator to call a different box.
//
// The gate reads the source, because these are defects of WHAT THE PRODUCT
// SAYS, and the only honest way to check what it says is to read it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { walkFiles } from '../helpers/schema-model';

const ROOT = path.resolve(__dirname, '..', '..');

/** The repo-relative path, so a failure names a file the reader can open. */
function rel(file: string): string {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/**
 * Every source file under `src/`, read.
 *
 * The scan is SYNCHRONOUS on purpose. Vitest's per-test timeout is a timer
 * that races the test body, so a body that AWAITS can be interrupted by it:
 * on a machine under load a scan that yields once per file blows the
 * thirty-second budget, and the gate then reports a timeout instead of an
 * answer. A body that BLOCKS cannot be interrupted that way — the gate waits
 * for the scan, and then judges the result it read.
 *
 * This is the same walk the other two contract tests use.
 */
function sourceFiles(): { name: string; text: string }[] {
  return walkFiles(path.join(ROOT, 'src'), (f) => /\.(ts|tsx)$/.test(f)).map(
    (full) => ({ name: rel(full), text: readFileSync(full, 'utf8') }),
  );
}

/**
 * The source with its COMMENTS removed.
 *
 * A comment that QUOTES the broken output in order to explain it is not a
 * published placeholder — it is the opposite. Matching the raw text made the
 * gate fail on the very comment that documents the defect it was written for.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s*\/\/.*$/gm, '');
}

/** The legal pages, and the shell they share. */
const LEGAL_PAGES = [
  'src/lib/legal.ts',
  'src/lib/legal-operator.ts',
  'src/app/terms/page.tsx',
  'src/app/privacy/page.tsx',
  'src/app/acceptable-use/page.tsx',
  'src/app/dpa/page.tsx',
  'src/app/accessibility/page.tsx',
  'src/app/legal/accept/page.tsx',
  'src/components/legal/LegalShell.tsx',
];

describe('the identity the legal pages publish', () => {
  it('publishes no bracketed placeholder', async () => {
    // A legal document with a placeholder in it is a document nobody can sign.
    const pattern = /\[[a-z][a-z ]*(number|address|name|email)\]/i;
    const offenders: string[] = [];
    for (const page of LEGAL_PAGES) {
      const text = await readFile(path.join(ROOT, page), 'utf8');
      if (withoutComments(text).match(pattern)) offenders.push(page);
    }
    expect(offenders).toEqual([]);
  });

  it('publishes no upstream vendor domain, anywhere in the application', () => {
    const files = sourceFiles();
    // A scan that found nothing has not looked at anything. The gate must
    // not pass because it read nothing.
    expect(files.some((f) => f.name === 'src/lib/legal.ts')).toBe(true);

    const offenders = files
      .filter((file) => file.text.includes('elitesolutionshub.com'))
      .map((file) => file.name);
    // The upstream SaaS's operator is not a party to anything on this box.
    expect(offenders).toEqual([]);
  });

  it('takes the operator from the tenant on a box the customer operates', async () => {
    const resolver = await readFile(path.join(ROOT, 'src/lib/legal-operator.ts'), 'utf8');
    // `customerOps` is true for exactly the profiles the customer operates
    // (standalone, hosted) and false for the ones the platform operates
    // (saas, managed, managed-shared). The legal identity follows the
    // profile: the platform's own name on the SaaS, the tenant's on a box
    // the tenant owns.
    expect(resolver).toContain('customerOps');

    // And no legal page reaches for a constant instead of resolving it. A
    // page that imports the operator as a value has frozen the identity of
    // whoever ran the build, which is exactly the defect.
    const pages = LEGAL_PAGES.filter((p) => p.endsWith('page.tsx'));
    for (const page of pages) {
      const text = await readFile(path.join(ROOT, page), 'utf8');
      expect(
        text,
        `${page} imports a constant operator instead of resolving one`,
      ).not.toMatch(/import\s*\{[^}]*\bOPERATOR\b[^}]*\}\s*from\s*['"]@\/lib\/legal['"]/);
      expect(text, `${page} does not resolve the operator per request`).toContain(
        'resolveOperator',
      );
    }
  });
});

describe('the accessibility statement names the right body', () => {
  it('carries an enforcement body in every region pack', async () => {
    const { regionProvider } = await import('@/lib/region');
    for (const id of ['uk', 'ng'] as const) {
      const pack = regionProvider(id);
      const enforcement = (pack as unknown as Record<string, unknown>)
        .accessibilityEnforcement as
        | { law?: string; body?: string; url?: string }
        | undefined;
      expect(enforcement, `${id} has no enforcement body`).toBeDefined();
      expect(enforcement?.law, `${id} names no statute`).toBeTruthy();
      expect(enforcement?.body, `${id} names no body`).toBeTruthy();
      expect(enforcement?.url, `${id} gives no address`).toBeTruthy();
    }
  });

  it('names a different body in each region — the UK law is not the Nigerian law', async () => {
    const { regionProvider } = await import('@/lib/region');
    const uk = (regionProvider('uk') as unknown as Record<string, unknown>)
      .accessibilityEnforcement as { body: string };
    const ng = (regionProvider('ng') as unknown as Record<string, unknown>)
      .accessibilityEnforcement as { body: string };
    expect(uk.body).not.toBe(ng.body);
  });

  it('does not hardcode the body of one region in the page', async () => {
    const page = await readFile(path.join(ROOT, 'src/app/accessibility/page.tsx'), 'utf8');
    expect(page).not.toContain('equalityadvisoryservice.com');
  });
});

describe('the HMRC redirect URI', () => {
  it('is never localhost — an install that cannot know its own address is not connected', async () => {
    const ORIGINAL = { ...process.env };
    try {
      process.env.HMRC_MTD_CLIENT_ID = 'client-id';
      process.env.HMRC_MTD_CLIENT_SECRET = 'client-secret';
      delete process.env.HMRC_MTD_REDIRECT_URI;
      delete process.env.NEXT_PUBLIC_APP_URL;
      const { readMtdConfig } = await import('@/lib/accounting/mtd');
      expect(readMtdConfig()).toBeNull();
    } finally {
      process.env = { ...ORIGINAL };
    }
  });

  it('uses the configured address when there is one', async () => {
    const ORIGINAL = { ...process.env };
    try {
      process.env.HMRC_MTD_CLIENT_ID = 'client-id';
      process.env.HMRC_MTD_CLIENT_SECRET = 'client-secret';
      delete process.env.HMRC_MTD_REDIRECT_URI;
      process.env.NEXT_PUBLIC_APP_URL = 'https://fleet.example.test';
      const { readMtdConfig } = await import('@/lib/accounting/mtd');
      expect(readMtdConfig()?.redirectUri).toBe(
        'https://fleet.example.test/api/v1/accounting/mtd/callback',
      );
    } finally {
      process.env = { ...ORIGINAL };
    }
  });
});

describe('the incident queue photo', () => {
  it('does not point the photo link at the charge-media route', async () => {
    const page = await readFile(path.join(ROOT, 'src/app/ops/incidents/page.tsx'), 'utf8');
    // `charge_media.id` is a media row's id. The queue holds a storage path.
    expect(page).not.toContain('/api/receipts/media/');
  });

  it('has a route that serves the report photo from the report', async () => {
    const route = path.join(ROOT, 'src/app/api/damage-reports/[id]/photo/route.ts');
    const text = await readFile(route, 'utf8');
    expect(text).toContain('driver_damage_reports');
    // Scoped to the caller's own tenant, like every other media route.
    expect(text).toContain('tenant_id');
  });
});

describe('the cron snippet on the billing page', () => {
  it('names no domain of its own', async () => {
    const card = await readFile(path.join(ROOT, 'src/app/ops/billing/OverdueCheckCard.tsx'), 'utf8');
    expect(card).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});
