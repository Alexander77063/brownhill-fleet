/**
 * tests/unit/contract-drift.test.ts
 *
 * The contract system has three moving parts — the content module that holds
 * the words, the shipped document, and the application that fills it — and
 * they drift apart quietly.
 *
 *   - A clause is tightened in the module and the shipped Word file still
 *     says the old thing. The next build overwrites the hand-edit and
 *     nobody notices either way.
 *   - A field is added to the application and the document has no box for it,
 *     so the value is silently dropped at the last step.
 *   - A particular that only the operator can supply is not on the outstanding
 *     list, so an agreement goes out with a blank in it.
 *
 * All three come back from the customer. They are checked here on every build
 * rather than noticed later.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   1. The shipped document is exactly what the content module renders. Not
 *      "close" — the same bytes. A hand-edit to a shipped document is a
 *      defect, because the next build silently reverts it.
 *   2. No clause refers to a field the document does not define, so no raw
 *      `{{token}}` can reach a customer.
 *   3. The application and the document agree about which particulars exist:
 *      every value the application computes has a box, and every particular
 *      the application leaves blank is one the operator completes later, or
 *      one with a stated reason.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  BLOCKS as RENTAL_BLOCKS,
  FIELDS as RENTAL_FIELDS,
  GROUPS as RENTAL_GROUPS,
  RETURN_ONLY_FIELDS as RENTAL_RETURN_ONLY,
  VARIANT_META as RENTAL_VARIANT_META,
} from '../../scripts/contracts/rental-agreement-content.mjs';
import {
  BLOCKS as RTB_BLOCKS,
  FIELDS as RTB_FIELDS,
  GROUPS as RTB_GROUPS,
  META as RTB_META,
  RETURN_ONLY_FIELDS as RTB_RETURN_ONLY,
} from '../../scripts/contracts/rent-to-buy-content.mjs';
import {
  auditBlocks,
  buildDocx,
  buildHtml,
  makeContext,
} from '../../scripts/contracts/render-contract.mjs';
import {
  buildAgreementFieldValues,
  contractTemplateFields,
  contractTemplateFile,
  type InsuranceModel,
} from '@/lib/contracts';
import type { TenantBranding } from '@/lib/branding';

const DOCS_DIR = path.join(process.cwd(), 'docs', 'contracts');

/* ── Reading a .docx ───────────────────────────────────────────────────────── */

/**
 * Read the parts out of a .docx.
 *
 * A .docx is a ZIP. The renderer writes it with the STORE method, so every
 * entry is stored uncompressed and the payload can be sliced straight out.
 */
function readZip(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory header');
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    entries.set(name, buf.slice(start, start + csize));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One named part of a .docx, as text. */
function docxPart(buf: Buffer, wanted: string): string {
  const data = readZip(buf).get(wanted);
  if (!data) throw new Error(`${wanted} is missing from the .docx`);
  return data.toString('utf8');
}

/* ── The editions ──────────────────────────────────────────────────────────── */

interface Edition {
  /** How the edition is named in a test failure. */
  name: string;
  /** The agreement type the application asks for. */
  type: 'standard' | 'rtb';
  /** The insurance model the application asks for. */
  model: InsuranceModel;
  /** The document the application will serve. */
  htmlFilename: string;
  /** The Word version of the same document. */
  docxFilename: string;
  /** The blocks the document is built from. */
  blocks: unknown[];
  /** The context, built exactly as the build script builds it. */
  ctx: () => object;
}

/**
 * The three shipped documents.
 *
 * Each context is built exactly as the corresponding build script builds it,
 * because the point of the comparison is that the shipped file and the build
 * agree — not that two different renderings happen to look alike.
 */
const EDITIONS: Edition[] = [
  {
    name: 'standard hire, company insured',
    type: 'standard',
    model: 'company',
    htmlFilename: RENTAL_VARIANT_META.company.htmlFilename,
    docxFilename: RENTAL_VARIANT_META.company.docxFilename,
    blocks: RENTAL_BLOCKS,
    ctx: () =>
      makeContext({
        variant: 'company',
        fields: RENTAL_FIELDS,
        returnOnlyFields: RENTAL_RETURN_ONLY,
        groups: RENTAL_GROUPS,
        meta: RENTAL_VARIANT_META.company,
      }),
  },
  {
    name: 'standard hire, self insured',
    type: 'standard',
    model: 'self',
    htmlFilename: RENTAL_VARIANT_META.self.htmlFilename,
    docxFilename: RENTAL_VARIANT_META.self.docxFilename,
    blocks: RENTAL_BLOCKS,
    ctx: () =>
      makeContext({
        variant: 'self',
        fields: RENTAL_FIELDS,
        returnOnlyFields: RENTAL_RETURN_ONLY,
        groups: RENTAL_GROUPS,
        meta: RENTAL_VARIANT_META.self,
      }),
  },
  {
    name: 'rent-to-buy',
    type: 'rtb',
    model: 'self',
    htmlFilename: RTB_META.htmlFilename,
    docxFilename: RTB_META.docxFilename,
    blocks: RTB_BLOCKS,
    ctx: () =>
      makeContext({
        fields: RTB_FIELDS,
        returnOnlyFields: RTB_RETURN_ONLY,
        groups: RTB_GROUPS,
        meta: RTB_META,
      }),
  },
];

/* ── The application's view of an agreement ────────────────────────────────── */

const BRANDING: TenantBranding = {
  legal_name: 'Brownhill Fleet Ltd',
  trading_name: 'Brownhill Fleet',
  address: '2 Low Road, Leeds LS11 9AB',
  phone: '0113 000 0000',
  email: 'ops@brownhill.example',
  company_number: '12345678',
  vat_number: 'GB123456789',
  fleet_insurer: 'QBE',
  fleet_policy_number: 'QBE999',
  fleet_policy_expiry: '31/12/2027',
  breakdown_number: '0800 111 2222',
};

const VEHICLE = {
  registration: 'AB12 CDE',
  vin: 'VIN123456',
  make: 'Toyota',
  model: 'Corolla',
  colour: 'Silver',
  model_year: 2023,
  fuel: 'petrol',
  list_value_pence: 3_000_000,
};

const DRIVER = {
  full_name: 'Jane Doe',
  address: '1 High Street, London N1 1AA',
  date_of_birth: '1990-01-01',
  phone: '07700 900000',
  email: 'jane@example.com',
  pco_licence_no: 'PCO123456',
  dvla_licence_no: null,
};

const CERT = {
  status: 'verified',
  insurer: 'Aviva',
  policy_no: 'AV123456',
  cover_from: '2026-01-01',
  cover_to: '2027-01-01',
  company_interested_party: false,
};

const STANDARD_AGREEMENT = {
  id: 'a1',
  type: 'standard' as const,
  start_date: '2026-09-01',
  end_date: null,
  term_weeks: 52,
  term_months: null,
  notice_weeks: 4,
  weekly_gross_pence: 20_000,
  weekly_net_pence: 16_667,
  weekly_vat_pence: 3_333,
  monthly_gross_pence: null,
  deposit_pence: 50_000,
  option_credit_weekly_pence: null,
  agreed_residual_pence: null,
  agreed_vehicle_price_pence: null,
  excess_mile_pence: 100,
};

const RTB_AGREEMENT = {
  id: 'a2',
  type: 'rtb' as const,
  start_date: '2026-09-01',
  end_date: null,
  term_weeks: 156,
  term_months: 36,
  notice_weeks: 4,
  weekly_gross_pence: 102_000,
  weekly_net_pence: 85_000,
  weekly_vat_pence: 17_000,
  monthly_gross_pence: 442_000,
  deposit_pence: 500_000,
  option_credit_weekly_pence: 16_250,
  agreed_residual_pence: 3_500_000,
  agreed_vehicle_price_pence: 4_000_000,
  excess_mile_pence: 15,
};

/** The values the application would put on this edition of the document. */
function appValues(ed: Edition): Record<string, string> {
  const rtb = ed.type === 'rtb';
  return buildAgreementFieldValues({
    type: ed.type,
    model: ed.model,
    agreement: rtb ? RTB_AGREEMENT : STANDARD_AGREEMENT,
    vehicle: VEHICLE,
    driver: DRIVER,
    cert: ed.model === 'self' || rtb ? CERT : null,
    branding: BRANDING,
    todayISO: '2026-09-01',
  });
}

/**
 * The particulars the application cannot fill, and why.
 *
 * Everything else the application leaves blank is completed by the operator at
 * handover or when the vehicle comes back, and the document says so.
 */
const BLANK_BEFORE_SIGNING: Record<string, Record<string, string>> = {
  'standard hire, company insured': {},
  'standard hire, self insured': {
    // The excess on the Customer's OWN policy, which the platform does not
    // hold. The operator reads it off the policy before the agreement is
    // signed — the agreement must not quote our fleet excess instead.
    damageExcessAmount: 'the excess on the customer’s own policy',
  },
  'rent-to-buy': {
    // The same: the Customer's own policy excess, not a published figure.
    damageExcessAmount: 'the excess on the customer’s own policy',
  },
};

/* ── The document and the content module ───────────────────────────────────── */

/**
 * The first place two documents differ, or null when they are the same.
 *
 * The gate below and the negative control beside it use this same function,
 * so the control proves the gate is actually looking.
 */
function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  const limit = Math.min(a.length, b.length);
  while (i < limit && a[i] === b[i]) i++;
  const at = (s: string) => s.slice(Math.max(0, i - 40), i + 60).replace(/\s+/g, ' ');
  return `at character ${i}:\n  shipped: ${at(a)}\n  built:   ${at(b)}`;
}

describe('the shipped document is what the content module builds', () => {
  for (const ed of EDITIONS) {
    it(`${ed.name}: the application serves the document this edition builds`, () => {
      expect(contractTemplateFile(ed.type, ed.model)).toBe(ed.htmlFilename);
    });

    it(`${ed.name}: the fillable HTML matches the content module exactly`, () => {
      const shipped = readFileSync(path.join(DOCS_DIR, ed.htmlFilename), 'utf8');
      expect(firstDifference(shipped, buildHtml(ed.blocks, ed.ctx()))).toBeNull();
    });

    it(`${ed.name}: the Word document carries the rendered clauses`, () => {
      // The .docx records when it was built, so the archives cannot be
      // compared byte for byte. The clauses can.
      const shipped = readFileSync(path.join(DOCS_DIR, ed.docxFilename));
      const built = buildDocx(ed.blocks, ed.ctx());
      expect(
        firstDifference(docxPart(shipped, 'word/document.xml'), docxPart(built, 'word/document.xml')),
      ).toBeNull();
    });

    it(`${ed.name}: no clause refers to a field the document does not define`, () => {
      const { unknown } = auditBlocks(ed.blocks, ed.ctx());
      expect(unknown).toEqual([]);
    });
  }
});

describe('the drift check is sensitive', () => {
  // A negative control. Without it, a gate that compared nothing would pass
  // every document and a hand-edited contract would sail through the build.
  it('sees a hand-edit to a shipped document', () => {
    const ed = EDITIONS[0];
    const shipped = readFileSync(path.join(DOCS_DIR, ed.htmlFilename), 'utf8');
    const built = buildHtml(ed.blocks, ed.ctx());
    const handEdited = shipped.replace(
      'motor insurance arranged by the Lessor',
      'motor insurance arranged by nobody',
    );
    expect(handEdited).not.toBe(shipped);
    expect(firstDifference(handEdited, built)).not.toBeNull();
  });

  it('sees a clause that has been dropped from a document', () => {
    const ed = EDITIONS[0];
    const shipped = readFileSync(path.join(DOCS_DIR, ed.htmlFilename), 'utf8');
    const built = buildHtml(ed.blocks, ed.ctx());
    const truncated = shipped.slice(0, Math.floor(shipped.length / 2));
    expect(firstDifference(truncated, built)).not.toBeNull();
  });
});

/* ── The document and the application ──────────────────────────────────────── */

describe('the application and the document agree about the particulars', () => {
  for (const ed of EDITIONS) {
    it(`${ed.name}: every value the application computes has a box in the document`, () => {
      const html = readFileSync(path.join(DOCS_DIR, ed.htmlFilename), 'utf8');
      const docKeys = new Set(contractTemplateFields(html).map((f) => f.key));
      const orphans = Object.keys(appValues(ed)).filter((k) => !docKeys.has(k));
      expect(orphans).toEqual([]);
    });

    it(`${ed.name}: everything left blank is completed later, or has a stated reason`, () => {
      const html = readFileSync(path.join(DOCS_DIR, ed.htmlFilename), 'utf8');
      const values = appValues(ed);
      const fields = contractTemplateFields(html);
      const allowed = BLANK_BEFORE_SIGNING[ed.name] ?? {};

      const unexplained = fields
        .filter((f) => !f.optional)
        .filter((f) => f.stage === 'agreement')
        .filter((f) => !String(values[f.key] ?? '').trim())
        .filter((f) => !(f.key in allowed))
        .map((f) => f.key);

      expect(unexplained).toEqual([]);
    });

    it(`${ed.name}: a blank particular is always one the operator can complete`, () => {
      // A field left blank for the operator must exist in the document and be
      // fillable — otherwise the outstanding list tells the operator to
      // complete something there is nowhere to complete.
      const html = readFileSync(path.join(DOCS_DIR, ed.htmlFilename), 'utf8');
      const fields = contractTemplateFields(html);
      const values = appValues(ed);
      const blank = fields.filter((f) => !String(values[f.key] ?? '').trim());
      expect(blank.length).toBeGreaterThan(0);
      for (const f of blank) {
        expect(html).toContain(`name="${f.key}"`);
      }
    });
  }
});
