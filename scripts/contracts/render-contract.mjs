/**
 * scripts/contracts/render-contract.mjs
 *
 * The renderer for Brownhill Fleet's agreements.
 *
 * WHAT THIS IS
 * ------------
 * The clause text of each agreement lives in its own content module
 * (`rental-agreement-content.mjs` for the standard hire, `rent-to-buy-content.mjs`
 * for the rent-to-buy). This module turns one of those block lists into the two
 * deliverables — a Word template and a browser-fillable form — and it is the
 * ONLY place that knows how either format is written.
 *
 * WHY IT IS SEPARATE
 * ------------------
 * The renderer used to live inside `build-rental-agreement.mjs`, which meant
 * there was exactly one agreement and exactly one renderer, in one file. The
 * second agreement made that untenable: a renderer that cannot be reused is a
 * renderer that gets copied, and two copies of a document writer drift.
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
 * THE ONE RULE
 * ------------
 * Rendering the standard agreement with no values must produce the same bytes
 * it produced before this module existed. The standard agreement's shipped
 * deliverables are checked into the repository, so a change here that moves
 * them is visible in `git diff` — and the build script fails loudly if the
 * content module references a field that does not exist.
 */

import { crc32 } from 'node:zlib';

// ─────────────────────────────────────────────────────────────────────────────
// The context: one agreement's fields, groups, metadata and (optional) values.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the renderer context for one agreement.
 *
 * `values` pre-fills the document. The build scripts pass none — the shipped
 * deliverables are blank templates. The application passes the agreement's
 * database row so the generated copy carries the real figures.
 *
 * VARIANTS
 * --------
 * Some agreements come in more than one edition. The standard hire does: the
 * vehicle either rides on Brownhill's fleet policy (company-insured) or the
 * customer brings their own policy (self-insured), and the two need different
 * words in the insurance clause and different fields on the form.
 *
 * A variant is a name — `'company'` or `'self'`. A field or a block may carry
 * `only: '<variant>'`, and it is included only when the context's variant
 * matches. Everything untagged is in every edition.
 *
 * @param {object} spec
 * @param {string} [spec.variant]
 * @param {Array<{key:string,label:string,len?:number,type?:string,hint?:string,group?:string,only?:string}>} spec.fields
 * @param {Array<{key:string,label:string,len?:number,type?:string,hint?:string,only?:string}>} [spec.returnOnlyFields]
 * @param {Array<{id:string,label:string}>} spec.groups
 * @param {{title:string,subtitle?:string,docxFilename:string,htmlFilename:string}} spec.meta
 * @param {Record<string,string>} [spec.values]
 */
export function makeContext(spec) {
  const variant = spec.variant ?? 'default';
  const inVariant = (f) => f.only === undefined || f.only === variant;
  const fields = (spec.fields ?? []).filter(inVariant);
  const returnOnlyFields = (spec.returnOnlyFields ?? []).filter(inVariant);
  const all = [...fields, ...returnOnlyFields];
  const values = spec.values ?? {};

  const lookup = (key) => all.find((f) => f.key === key) ?? null;

  return {
    variant,
    fields,
    returnOnlyFields,
    groups: spec.groups ?? [],
    meta: spec.meta ?? {},
    values,

    /** The field definition for a key, or null. */
    field: lookup,

    /** True when the key belongs to the end-of-hire record rather than the agreement itself. */
    isReturnOnly(key) {
      return returnOnlyFields.some((f) => f.key === key);
    },

    /**
     * True when the key may legitimately be left blank.
     *
     * Some particulars are not always known when the agreement is drafted — an
     * end date on a rolling hire, an odometer reading that is taken at
     * handover. Those are marked optional in the content module, and the
     * application reads that mark out of the shipped document so that it never
     * asks the operator for a particular the agreement does not need.
     */
    isOptional(key) {
      const f = lookup(key);
      return !!f && f.optional === true;
    },

    /**
     * The stage of the hire a particular belongs to: 'agreement' (before
     * signing), 'handover' (on the day the Vehicle changes hands) or 'return'
     * (when the Vehicle comes back). The application reads it out of the
     * shipped document so the list of outstanding items is grouped the way the
     * agreement itself is.
     */
    stageFor(key) {
      if (returnOnlyFields.some((f) => f.key === key)) return 'return';
      const f = lookup(key);
      return (f && f.stage) || 'agreement';
    },

    /** The bracketed label Word shows for a field, e.g. `[CUSTOMER’S FULL NAME]`. */
    placeholderFor(key) {
      const f = lookup(key);
      return f ? `[${String(f.label).toUpperCase()}]` : `[${key.toUpperCase()}]`;
    },

    /** The pre-filled value for a key, or an empty string. */
    value(key) {
      const v = values[key];
      return v === null || v === undefined ? '' : String(v);
    },
  };
}

/**
 * The blocks that belong to a variant.
 *
 * A block tagged `only: '<variant>'` belongs to that edition alone. The
 * renderer asks this rather than testing the tag itself, so the Word and the
 * HTML output can never disagree about which blocks are in the document.
 */
export function blocksForVariant(blocks, ctx) {
  return blocks.filter((b) => b.only === undefined || b.only === ctx.variant);
}

/**
 * The rows of a `fields` block that belong to a variant.
 *
 * A row is either an array of cells, or `{ cells, only }` when the row appears
 * in one edition only — the insurance rows of the standard hire differ between
 * the company-insured and self-insured editions, and they belong in the same
 * table rather than in two tables.
 */
export function rowsForVariant(rows, ctx) {
  const out = [];
  for (const r of rows) {
    if (Array.isArray(r)) {
      out.push(r);
      continue;
    }
    if (r.only !== undefined && r.only !== ctx.variant) continue;
    out.push(r.cells);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// A minimal ZIP writer (STORE method).
// ─────────────────────────────────────────────────────────────────────────────

function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
}

function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

/**
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {Buffer} a ZIP archive
 */
function makeZip(entries, when = new Date()) {
  const time = dosTime(when);
  const date = dosDate(when);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ─────────────────────────────────────────────────────────────────────────────
// OOXML rendering.
// ─────────────────────────────────────────────────────────────────────────────

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** The token pattern: `{{key}}`. */
const TOKEN_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/**
 * Splits text into plain and token parts, so each part can be rendered with
 * its own run properties.
 */
function splitTokens(text) {
  const parts = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', value: text.slice(last, m.index) });
    parts.push({ kind: 'field', value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

function run(text, { bold = false, italic = false, size = null, color = null } = {}) {
  // Element order inside w:rPr is fixed by the OOXML schema: b, i, color, sz.
  // Word tolerates a different order; LibreOffice and strict validators do not.
  const rPr =
    (bold ? '<w:b/>' : '') +
    (italic ? '<w:i/>' : '') +
    (color ? `<w:color w:val="${color}"/>` : '') +
    (size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '');
  const props = rPr ? `<w:rPr>${rPr}</w:rPr>` : '';
  return `<w:r>${props}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** A run for a fill-in placeholder: bold, on a light grey background. */
function fillRun(key, ctx) {
  // A pre-filled value is written as the value itself, not as a placeholder.
  const value = ctx.value(key);
  if (value) return run(value, { bold: true });
  return (
    `<w:r><w:rPr><w:b/><w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/></w:rPr>` +
    `<w:t xml:space="preserve">${esc(ctx.placeholderFor(key))}</w:t></w:r>`
  );
}

/** A paragraph whose text may contain `{{key}}` tokens. */
function para(text, ctx, opts = {}) {
  const { style, align, spacing, indent } = opts;
  // w:pPr children are order-sensitive too: pStyle, keepNext, pBdr, spacing,
  // ind, jc.
  const pPrParts = [];
  if (style) pPrParts.push(`<w:pStyle w:val="${style}"/>`);
  if (spacing) pPrParts.push(spacing);
  if (indent) pPrParts.push(indent);
  if (align) pPrParts.push(`<w:jc w:val="${align}"/>`);
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : '';
  const body = splitTokens(text)
    .map((p) => (p.kind === 'field' ? fillRun(p.value, ctx) : run(p.value, opts)))
    .join('');
  return `<w:p>${pPr}${body}</w:p>`;
}

function cell(content, ctx, { width, header = false, shading = null, bold = false, align } = {}) {
  const tcPr = [
    width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : '',
    shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>` : '',
    '<w:vAlign w:val="center"/>',
  ].join('');
  const paras = Array.isArray(content)
    ? content
    : [para(content, ctx, { bold: header, align, spacing: '<w:spacing w:before="40" w:after="40"/>' })];
  return `<w:tc><w:tcPr>${tcPr}</w:tcPr>${paras.join('')}</w:tc>`;
}

/** A table with a hairline grid. */
function table(rows, ctx, { widths, headerRow = false, firstColBold = false } = {}) {
  const total = 9070; // usable width in twips for A4 with 2.5cm margins
  const cols = widths ?? rows[0].map((_, i) => (i === 0 ? 0.3 : 0.7 / (rows[0].length - 1)));
  const w = cols.map((c) => Math.round(total * c));
  const grid = w.map((x) => `<w:gridCol w:w="${x}"/>`).join('');
  const body = rows
    .map((cells, r) => {
      const isHead = headerRow && r === 0;
      const tcs = cells
        .map((c, i) =>
          cell(c, ctx, {
            width: w[i],
            header: isHead,
            bold: isHead || (firstColBold && i === 0),
            shading: isHead ? 'F2F2F2' : null,
          }),
        )
        .join('');
      const trPr = isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${tcs}</w:tr>`;
    })
    .join('');
  const borders = `<w:tblBorders>${[
    'top',
    'left',
    'bottom',
    'right',
    'insideH',
    'insideV',
  ]
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
    .join('')}</w:tblBorders>`;
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="9070" w:type="dxa"/>${borders}` +
    `<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>` +
    `<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>` +
    `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>` +
    // Word requires a paragraph after a table.
    `<w:p><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr></w:p>`
  );
}

function signatureTable(ctx) {
  const line = (label) => para(`${label}: ______________________________`, ctx);
  const rows = [
    [line('Signed'), line('Signed')],
    [line('Name'), line('Name')],
    [line('Date'), line('Date')],
    [
      para('Signed for and on behalf of the Lessor', ctx, { bold: true }),
      para('Signed by the Customer', ctx, { bold: true }),
    ],
  ];
  return table(rows, ctx, { widths: [0.5, 0.5], firstColBold: false });
}

function renderBlocks(blocks, ctx) {
  const out = [];
  for (const b of blocksForVariant(blocks, ctx)) {
    switch (b.t) {
      case 'title':
        out.push(para(b.text, ctx, { style: 'Title' }));
        break;
      case 'subtitle':
        out.push(para(b.text, ctx, { style: 'Subtitle' }));
        break;
      case 'meta':
        out.push(para(b.text, ctx, { style: 'Meta' }));
        break;
      case 'h1':
        out.push(para(b.text, ctx, { style: 'Heading1' }));
        break;
      case 'h2':
        out.push(para(b.text, ctx, { style: 'Heading2' }));
        break;
      case 'p':
        out.push(para(b.text, ctx, { spacing: '<w:spacing w:before="0" w:after="140"/>' }));
        break;
      case 'note':
        out.push(para(b.text, ctx, { style: 'Note' }));
        break;
      case 'list':
        for (const item of b.items) {
          out.push(
            para(`•  ${item}`, ctx, {
              spacing: '<w:spacing w:before="0" w:after="80"/>',
              indent: '<w:ind w:left="360" w:hanging="200"/>',
            }),
          );
        }
        break;
      case 'defs':
        out.push(table(b.rows, ctx, { widths: [0.24, 0.76], firstColBold: true }));
        break;
      case 'fields': {
        const rows = [];
        if (b.head) rows.push(b.head);
        rows.push(...rowsForVariant(b.rows, ctx));
        const cols = b.head ? b.head.length : b.rows[0].length;
        const widths = cols === 3 ? [0.32, 0.34, 0.34] : [0.32, 0.68];
        out.push(table(rows, ctx, { widths, headerRow: Boolean(b.head), firstColBold: true }));
        break;
      }
      case 'sign':
        out.push(signatureTable(ctx));
        break;
      case 'pagebreak':
        out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
      default:
        throw new Error(`Unknown block type: ${b.t}`);
    }
  }
  return out.join('');
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
      <w:sz w:val="21"/><w:szCs w:val="21"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr>
      <w:spacing w:before="0" w:after="140" w:line="276" w:lineRule="auto"/>
    </w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="60"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="40"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:i/><w:sz w:val="19"/><w:color w:val="595959"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Meta">
    <w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="320"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:sz w:val="19"/><w:color w:val="595959"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="D0D0D0"/></w:pBdr>
      <w:spacing w:before="280" w:after="120"/>
    </w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Note">
    <w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="120" w:after="120"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:i/><w:color w:val="808080"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Footer">
    <w:name w:val="footer"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>
    <w:rPr><w:sz w:val="16"/><w:color w:val="808080"/></w:rPr>
  </w:style>
</w:styles>`;

function documentXml(blocks, ctx) {
  const body = renderBlocks(blocks, ctx);
  const sectPr =
    '<w:sectPr>' +
    '<w:footerReference r:id="rId2" w:type="default"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/>' +
    '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/>' +
    '</w:sectPr>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}${sectPr}</w:body></w:document>`
  );
}

function footerXml(ctx) {
  // `w:instrText` is run inner content: it MUST be wrapped in a `w:r`. The
  // build script had it loose, which Word tolerates and LibreOffice and
  // strict validators do not.
  const field = (instr) =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  // The footer names the agreement, and the reference. A blank template keeps
  // the reference as a visible token so the person filling it in knows what to
  // replace; a filled copy carries the real reference.
  const label = ctx.meta.footerLabel ?? 'Vehicle Rental Agreement';
  const reference = ctx.value('agreementReference');
  const footerText = reference
    ? `${label} — reference ${reference}`
    : `${label} — reference {{agreementReference}}`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:pStyle w:val="Footer"/>' +
    '<w:tabs><w:tab w:val="right" w:pos="9070"/></w:tabs></w:pPr>' +
    run(footerText) +
    '<w:r><w:tab/></w:r>' +
    run('Page ') +
    field('PAGE') +
    run(' of ') +
    field('NUMPAGES') +
    '</w:p></w:ftr>'
  );
}

/**
 * Build the .docx for one agreement.
 *
 * @param {Array} blocks the agreement's block list
 * @param {object} ctx the context from `makeContext`
 * @returns {Buffer}
 */
export function buildDocx(blocks, ctx) {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const docRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
    '</Relationships>';

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(ctx.meta.title)} — template</dc:title>` +
    '<dc:creator>Brownhill Fleet</dc:creator>' +
    '<cp:lastModifiedBy>Brownhill Fleet</cp:lastModifiedBy>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>';

  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Brownhill Fleet contract generator</Application>' +
    '<Company>Brownhill Fleet</Company>' +
    '</Properties>';

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(blocks, ctx), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(footerXml(ctx), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(app, 'utf8') },
  ];

  return makeZip(entries);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML rendering — a form the customer fills in and prints.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fillable field.
 *
 * With a pre-filled value the input carries it, so the generated copy shows the
 * agreement's real figures without the customer re-typing them. Without one it
 * is an empty box, exactly as the shipped blank template has it.
 */
function htmlField(key, ctx) {
  const f = ctx.field(key);
  const label = f ? f.label : key;
  const hint = f && f.hint ? f.hint : '';
  const len = f && f.len ? f.len : 24;
  const type = f && f.type ? f.type : 'text';
  // `data-return` marks the end-of-hire record, so the application can tell
  // "still to be completed before this agreement is signed" from "completed
  // when the vehicle comes back" without keeping its own copy of the list.
  // `data-optional` marks a particular that may legitimately be blank — an end
  // date on a rolling hire, an odometer reading taken at handover.
  // `data-stage` says when in the hire the particular is completed.
  const stage = ctx.stageFor(key);
  const marker =
    (ctx.isReturnOnly(key) ? ' data-return="1"' : '') +
    (ctx.isOptional(key) ? ' data-optional="1"' : '') +
    (stage !== 'agreement' ? ` data-stage="${stage}"` : '');
  const common =
    `class="field" name="${esc(key)}" aria-label="${esc(label)}" ` +
    `placeholder="${esc(hint)}" data-label="${esc(label)}"${marker}`;
  const value = ctx.value(key);
  if (type === 'textarea') {
    return `<textarea ${common} rows="2">${esc(value)}</textarea>`;
  }
  const valueAttr = value ? ` value="${esc(value)}"` : '';
  if (type === 'date') {
    return `<input type="date" ${common} size="${len}"${valueAttr}>`;
  }
  return `<input type="text" ${common} size="${len}"${valueAttr}>`;
}

function htmlText(text, ctx) {
  return splitTokens(text)
    .map((p) => (p.kind === 'field' ? htmlField(p.value, ctx) : esc(p.value)))
    .join('');
}

function htmlSignature(ctx) {
  const cell = (label) => `<td>${esc(label)}: <span class="rule">&nbsp;</span></td>`;
  return (
    '<table class="sign"><tbody>' +
    `<tr>${cell('Signed')}${cell('Signed')}</tr>` +
    `<tr>${cell('Name')}${cell('Name')}</tr>` +
    `<tr>${cell('Date')}${cell('Date')}</tr>` +
    `<tr><td><strong>Signed for and on behalf of the Lessor</strong></td>` +
    '<td><strong>Signed by the Customer</strong></td></tr>' +
    '</tbody></table>'
  );
}

function renderHtmlBlocks(blocks, ctx) {
  const out = [];
  for (const b of blocksForVariant(blocks, ctx)) {
    switch (b.t) {
      case 'title':
        out.push(`<h1 class="doc-title">${esc(b.text)}</h1>`);
        break;
      case 'subtitle':
        out.push(`<p class="doc-subtitle">${esc(b.text)}</p>`);
        break;
      case 'meta':
        out.push(`<p class="doc-meta">${htmlText(b.text, ctx)}</p>`);
        break;
      case 'h1':
        out.push(`<h2>${esc(b.text)}</h2>`);
        break;
      case 'h2':
        out.push(`<h3>${esc(b.text)}</h3>`);
        break;
      case 'p':
        out.push(`<p>${htmlText(b.text, ctx)}</p>`);
        break;
      case 'note':
        out.push(`<p class="note">${esc(b.text)}</p>`);
        break;
      case 'list':
        out.push(`<ul>${b.items.map((i) => `<li>${htmlText(i, ctx)}</li>`).join('')}</ul>`);
        break;
      case 'defs':
        out.push(
          `<table>${b.rows
            .map(
              (r) =>
                `<tr><td class="term">${esc(r[0])}</td><td>${htmlText(r[1], ctx)}</td></tr>`,
            )
            .join('')}</table>`,
        );
        break;
      case 'fields': {
        const variantRows = rowsForVariant(b.rows, ctx);
        const rows = b.head ? [b.head, ...variantRows] : variantRows;
        const cols = b.head ? b.head.length : b.rows[0].length;
        const widths = cols === 3 ? [32, 34, 34] : [32, 68];
        out.push(
          `<table>${rows
            .map((cells, r) =>
              r === 0 && b.head
                ? `<tr>${cells.map((c, i) => `<th style="width:${widths[i]}%">${esc(c)}</th>`).join('')}</tr>`
                : `<tr>${cells
                    .map((c, i) => `<td style="width:${widths[i]}%">${htmlText(c, ctx)}</td>`)
                    .join('')}</tr>`,
            )
            .join('')}</table>`,
        );
        break;
      }
      case 'sign':
        out.push(htmlSignature(ctx));
        break;
      case 'pagebreak':
        out.push('<div class="page-break"></div>');
        break;
      default:
        throw new Error(`Unknown block type: ${b.t}`);
    }
  }
  return out.join('\n');
}

/**
 * Build the fillable HTML form for one agreement.
 *
 * @param {Array} blocks the agreement's block list
 * @param {object} ctx the context from `makeContext`
 * @returns {string} the complete HTML document
 */
export function buildHtml(blocks, ctx) {
  const groupList = ctx.groups
    .map((g) => {
      const inputs = ctx.fields
        .filter((f) => f.group === g.id)
        .map((f) => {
          const input = htmlField(f.key, ctx);
          return `<div class="fr"><label>${esc(f.label)}</label>${input}</div>`;
        })
        .join('');
      return `<details open><summary>${esc(g.label)}</summary><div class="fr-grid">${inputs}</div></details>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ctx.meta.title)} — fillable template</title>
<style>
  :root {
    --ink: #16181d;
    --muted: #5b6270;
    --rule: #c9ced8;
    --accent: #1d4ed8;
    --fill: #fffdf3;
    --page: #f2f3f5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--ink);
    font: 16px/1.62 "Segoe UI", Calibri, system-ui, -apple-system, sans-serif;
  }
  .bar {
    position: sticky; top: 0; z-index: 10;
    background: #111827; color: #f9fafb;
    padding: 12px 20px;
    display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    box-shadow: 0 1px 6px rgba(0,0,0,.25);
  }
  .bar h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .bar p { margin: 0; font-size: 13px; color: #cbd5e1; flex: 1 1 320px; }
  .bar button {
    font: inherit; font-size: 14px; cursor: pointer;
    background: var(--accent); color: #fff; border: 0;
    padding: 9px 16px; border-radius: 6px;
  }
  .bar button.secondary { background: #374151; }
  .bar button:hover { filter: brightness(1.08); }
  .panel {
    max-width: 1100px; margin: 20px auto; background: #fff;
    border-radius: 10px; padding: 18px 22px; box-shadow: 0 1px 3px rgba(0,0,0,.12);
  }
  .panel h3 { margin: 18px 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .fr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px 18px; }
  .fr label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
  .paper {
    max-width: 820px; margin: 20px auto 60px; background: #fff;
    padding: 46px 56px; box-shadow: 0 1px 3px rgba(0,0,0,.12); border-radius: 4px;
  }
  .paper .doc-title { font-size: 22px; text-align: center; margin: 0 0 4px; letter-spacing: .02em; }
  .paper .doc-subtitle { text-align: center; color: var(--muted); font-style: italic; margin: 0 0 4px; font-size: 14px; }
  .paper .doc-meta { text-align: center; color: var(--muted); font-size: 13px; margin: 0 0 26px; }
  .paper h2 {
    font-size: 16px; margin: 26px 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid #e2e5ea;
  }
  .paper h3 { font-size: 14px; margin: 16px 0 6px; }
  .paper p { margin: 0 0 11px; }
  .paper ul { margin: 0 0 11px; padding-left: 22px; }
  .paper .note { text-align: center; color: var(--muted); font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 14px; font-size: 14px; }
  th, td { border: 1px solid #d9dde4; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #f5f6f8; font-weight: 600; }
  td.term { font-weight: 600; width: 24%; }
  table.sign td { border: 0; padding: 7px 9px 7px 0; width: 50%; }
  .rule { display: inline-block; min-width: 220px; border-bottom: 1px solid #444; }
  .field {
    font: inherit; color: inherit; background: var(--fill);
    border: 0; border-bottom: 1px solid var(--rule);
    padding: 1px 4px; border-radius: 3px 3px 0 0;
    min-width: 8ch; max-width: 100%;
  }
  textarea.field { width: 100%; vertical-align: top; }
  td .field { width: 100%; }
  .field:focus { outline: 2px solid var(--accent); outline-offset: 1px; background: #fff; }
  .page-break { break-after: page; page-break-after: always; height: 0; }
  @media print {
    @page { size: A4; margin: 18mm 16mm; }
    body { background: #fff; font-size: 10.5pt; line-height: 1.45; }
    .bar, .panel { display: none !important; }
    .paper {
      max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0;
    }
    .paper h2 { break-after: avoid; }
    .paper p, .paper li { orphans: 3; widows: 3; }
    table { break-inside: auto; }
    tr { break-inside: avoid; }
    .field {
      background: transparent !important; border-bottom: none !important;
      padding: 0 !important; min-width: 0; outline: none !important;
    }
    .rule { border-bottom: 1px solid #333; }
  }
</style>
</head>
<body>
  <div class="bar">
    <h2>${esc(ctx.meta.title)} — fillable template</h2>
    <p>Fill in the highlighted fields below, then print to PDF. The printed copy carries no form styling.</p>
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
    <button type="button" class="secondary" id="clear">Clear all fields</button>
  </div>

  <div class="panel">
    <h3>Complete these details</h3>
    <p style="font-size:13px;color:var(--muted);margin:0 0 12px">
      Everything here also appears in the agreement below — you can fill it in either place.
      ${esc(
        ctx.meta.panelNote ??
          'The “on return” column of Schedule 2 is completed by the Lessor when the vehicle comes back.',
      )}
    </p>
    ${groupList}
  </div>

  <div class="paper">
${renderHtmlBlocks(blocks, ctx)}
  </div>

<script>
  document.getElementById('clear').addEventListener('click', function () {
    if (!window.confirm('Clear every field in this form?')) return;
    document.querySelectorAll('.paper .field, .panel .field').forEach(function (el) { el.value = ''; });
  });
  // Mirror each panel input into the matching field in the agreement, and back.
  document.addEventListener('input', function (event) {
    var el = event.target;
    if (!el.classList || !el.classList.contains('field')) return;
    var name = el.getAttribute('name');
    if (!name) return;
    document.querySelectorAll('.field[name="' + name + '"]').forEach(function (other) {
      if (other !== el) other.value = el.value;
    });
  });
</script>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The self-check every build script runs.
// ─────────────────────────────────────────────────────────────────────────────

export const TOKEN_PATTERN = TOKEN_RE;

/**
 * Check a block list against its field list.
 *
 * A token that names a field nobody defined renders as a raw `{{token}}` in
 * the customer's document; a field nobody uses is a box the customer will be
 * asked to fill that the agreement never mentions. Both are defects, and both
 * are caught here rather than in a contract that has already been sent.
 *
 * @returns {{unknown: string[], unused: string[]}}
 */
export function auditBlocks(blocks, ctx) {
  const used = new Set();
  for (const b of blocksForVariant(blocks, ctx)) {
    const texts = [];
    if (b.text) texts.push(b.text);
    if (b.items) texts.push(...b.items);
    if (b.rows) for (const r of rowsForVariant(b.rows, ctx)) texts.push(...r);
    if (b.head) texts.push(...b.head);
    for (const t of texts) {
      for (const m of String(t).matchAll(TOKEN_RE)) used.add(m[1]);
    }
  }
  const known = new Set([...ctx.fields, ...ctx.returnOnlyFields].map((f) => f.key));
  const unknown = [...used].filter((k) => !known.has(k));
  const unused = [...known].filter((k) => !used.has(k));
  return {
    unknown,
    unused,
    usedCount: used.size,
    knownCount: known.size,
  };
}
