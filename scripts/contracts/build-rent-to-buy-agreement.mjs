/**
 * scripts/contracts/build-rent-to-buy-agreement.mjs
 *
 * Builds the two deliverables for Brownhill Fleet's rent-to-buy agreement
 * from the single source in `rent-to-buy-content.mjs`:
 *
 *   docs/contracts/Brownhill-Fleet-Rent-to-Buy-Agreement.docx
 *   docs/contracts/Brownhill-Fleet-Rent-to-Buy-Agreement-Fillable.html
 *
 * THE SOURCE OF TRUTH
 * -------------------
 * The clause text, the field list and the metadata all live in
 * `rent-to-buy-content.mjs`. This script writes no words of the agreement — it
 * hands the content to the shared renderer and writes what comes back.
 *
 * WHY IT IS A SEPARATE SCRIPT FROM THE RENTAL ONE
 * -----------------------------------------------
 * The rental agreement and the rent-to-buy agreement are two different
 * documents with two different legal characters. They share a renderer, not a
 * template. Running one script with a `--kind` switch would mean one file had
 * to know about both sets of clauses, and the file would grow a branch every
 * time a clause was added to either document.
 *
 * RUN
 * ---
 *   node scripts/contracts/build-rent-to-buy-agreement.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditBlocks, buildDocx, buildHtml, makeContext } from './render-contract.mjs';
import {
  BLOCKS,
  FIELDS,
  GROUPS,
  META,
  RETURN_ONLY_FIELDS,
} from './rent-to-buy-content.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT_DIR = path.join(REPO, 'docs/contracts');

// ─────────────────────────────────────────────────────────────────────────────
// Run.
// ─────────────────────────────────────────────────────────────────────────────

const ctx = makeContext({
  fields: FIELDS,
  returnOnlyFields: RETURN_ONLY_FIELDS,
  groups: GROUPS,
  meta: META,
});

mkdirSync(OUT_DIR, { recursive: true });

const docxPath = path.join(OUT_DIR, META.docxFilename);
const htmlPath = path.join(OUT_DIR, META.htmlFilename);

writeFileSync(docxPath, buildDocx(BLOCKS, ctx));
writeFileSync(htmlPath, buildHtml(BLOCKS, ctx), 'utf8');

const { unknown, unused, usedCount, knownCount } = auditBlocks(BLOCKS, ctx);

console.log(`Wrote ${docxPath}`);
console.log(`Wrote ${htmlPath}`);
console.log(`Fields used: ${usedCount} of ${knownCount}`);
if (unknown.length) {
  console.error(`\nUNKNOWN FIELD TOKENS (these would render as a raw {{token}}): ${unknown.join(', ')}`);
  process.exitCode = 1;
}
if (unused.length) {
  console.log(`Defined but not used: ${unused.join(', ')}`);
}
