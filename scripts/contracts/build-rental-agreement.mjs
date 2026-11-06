/**
 * scripts/contracts/build-rental-agreement.mjs
 *
 * Builds the deliverables for Brownhill Fleet's standard vehicle rental
 * agreement from the single source in `rental-agreement-content.mjs`:
 *
 *   docs/contracts/Brownhill-Fleet-Standard-Vehicle-Rental-Agreement.docx
 *   docs/contracts/Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html
 *   docs/contracts/Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Self-Insured.docx
 *   docs/contracts/Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Self-Insured-Fillable.html
 *
 * TWO EDITIONS
 * ------------
 * The standard hire ships as two editions — company-insured and
 * self-insured — because the customer either brings their own policy or is
 * covered by Brownhill's fleet policy. The clause text differs in exactly one
 * place (clause 6) and in the insurance rows of Schedule 1, so it is one
 * content module with the differing parts tagged, not two modules.
 *
 * THE SOURCE OF TRUTH
 * -------------------
 * The clause text, the field list and the metadata all live in
 * `rental-agreement-content.mjs`. This script does not write a single word of
 * the agreement — it hands the content to the renderer in
 * `render-contract.mjs` and writes what comes back.
 *
 * WHY THE RENDERER IS SHARED
 * ---------------------------
 * The rent-to-buy agreement is a second document with the same shape. Writing
 * a second renderer would mean two places to fix a Word quirk, and the two
 * would drift. So the renderer is shared and this script is content-specific.
 *
 * WHY NO LIBRARY
 * --------------
 * The repository has no document library. Adding `docx` or `jszip` for one
 * template would put a dependency in the application bundle for a file that is
 * produced once and then lives in `docs/`. A .docx is a ZIP of OOXML parts,
 * and Node can write both with nothing but `node:zlib`:
 *
 *   - The ZIP is written with the STORE method (compression method 0), so the
 *     payload is copied verbatim and no deflate implementation is needed.
 *     Word and LibreOffice both accept a stored .docx.
 *   - The CRC is `zlib.crc32`, which has shipped with Node since v22.2.
 *
 * RUN
 * ---
 *   node scripts/contracts/build-rental-agreement.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCKS,
  FIELDS,
  GROUPS,
  RETURN_ONLY_FIELDS,
  VARIANTS,
  VARIANT_META,
} from './rental-agreement-content.mjs';
import { auditBlocks, buildDocx, buildHtml, makeContext } from './render-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT_DIR = path.join(REPO, 'docs/contracts');

// ─────────────────────────────────────────────────────────────────────────────
// Run — one build per edition.
// ─────────────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

let failed = false;

for (const variant of VARIANTS) {
  const meta = VARIANT_META[variant];
  const ctx = makeContext({
    variant,
    fields: FIELDS,
    returnOnlyFields: RETURN_ONLY_FIELDS,
    groups: GROUPS,
    meta,
  });

  const docxPath = path.join(OUT_DIR, meta.docxFilename);
  const htmlPath = path.join(OUT_DIR, meta.htmlFilename);

  writeFileSync(docxPath, buildDocx(BLOCKS, ctx));
  writeFileSync(htmlPath, buildHtml(BLOCKS, ctx), 'utf8');

  const { unknown, unused, usedCount, knownCount } = auditBlocks(BLOCKS, ctx);

  console.log(`\n[${variant}]`);
  console.log(`Wrote ${docxPath}`);
  console.log(`Wrote ${htmlPath}`);
  console.log(`Fields used: ${usedCount} of ${knownCount}`);
  if (unknown.length) {
    console.error(`UNKNOWN FIELD TOKENS (these would render as a raw {{token}}): ${unknown.join(', ')}`);
    failed = true;
  }
  if (unused.length) {
    console.log(`Defined but not used: ${unused.join(', ')}`);
  }
}

if (failed) process.exitCode = 1;

