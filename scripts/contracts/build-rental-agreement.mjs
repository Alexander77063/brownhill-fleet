/**
 * scripts/contracts/build-rental-agreement.mjs
 *
 * Builds the two deliverables for Brownhill Fleet's standard vehicle rental
 * agreement from the single source in `rental-agreement-content.mjs`:
 *
 *   docs/contracts/Brownhill-Fleet-Standard-Vehicle-Rental-Agreement.docx
 *   docs/contracts/Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html
 *
 * WHY NO LIBRARY
 * --------------
 * The repository has no document library. Adding `docx` or `jszip` for one
 * template would put a dependency in the application bundle for a file that
 * is produced once and then lives in `docs/`. A .docx is a ZIP of OOXML
 * parts, and Node can write both with nothing but `node:zlib`:
 *
 *   - The ZIP is written with the STORE method (compression method 0), so
 *     the payload is copied verbatim and no deflate implementation is needed.
 *     Word and LibreOffice both accept a stored .docx.
 *   - The CRC is `zlib.crc32`, which has shipped with Node since v22.2.
 *
 * RUN
 * ---
 *   node scripts/contracts/build-rental-agreement.mjs
 */

import { crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCKS,
  FIELDS,
  GROUPS,
  META,
  RETURN_ONLY_FIELDS,
  field,
  placeholderFor,
} from './rental-agreement-content.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT_DIR = path.join(REPO, 'docs/contracts');

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
function fillRun(key) {
  return (
    `<w:r><w:rPr><w:b/><w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/></w:rPr>` +
    `<w:t xml:space="preserve">${esc(placeholderFor(key))}</w:t></w:r>`
  );
}

/** A paragraph whose text may contain `{{key}}` tokens. */
function para(text, opts = {}) {
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
    .map((p) => (p.kind === 'field' ? fillRun(p.value) : run(p.value, opts)))
    .join('');
  return `<w:p>${pPr}${body}</w:p>`;
}

function cell(content, { width, header = false, shading = null, bold = false, align } = {}) {
  const tcPr = [
    width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : '',
    shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>` : '',
    '<w:vAlign w:val="center"/>',
  ].join('');
  const paras = Array.isArray(content)
    ? content
    : [para(content, { bold: header, align, spacing: '<w:spacing w:before="40" w:after="40"/>' })];
  return `<w:tc><w:tcPr>${tcPr}</w:tcPr>${paras.join('')}</w:tc>`;
}

/** A table with a hairline grid. */
function table(rows, { widths, headerRow = false, firstColBold = false } = {}) {
  const total = 9070; // usable width in twips for A4 with 2.5cm margins
  const cols = widths ?? rows[0].map((_, i) => (i === 0 ? 0.3 : 0.7 / (rows[0].length - 1)));
  const w = cols.map((c) => Math.round(total * c));
  const grid = w.map((x) => `<w:gridCol w:w="${x}"/>`).join('');
  const body = rows
    .map((cells, r) => {
      const isHead = headerRow && r === 0;
      const tcs = cells
        .map((c, i) =>
          cell(c, {
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

function signatureTable() {
  const line = (label) => para(`${label}: ______________________________`);
  const rows = [
    [line('Signed'), line('Signed')],
    [line('Name'), line('Name')],
    [line('Date'), line('Date')],
    [
      para('Signed for and on behalf of the Lessor', { bold: true }),
      para('Signed by the Customer', { bold: true }),
    ],
  ];
  return table(rows, { widths: [0.5, 0.5], firstColBold: false });
}

function renderBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'title':
        out.push(para(b.text, { style: 'Title' }));
        break;
      case 'subtitle':
        out.push(para(b.text, { style: 'Subtitle' }));
        break;
      case 'meta':
        out.push(para(b.text, { style: 'Meta' }));
        break;
      case 'h1':
        out.push(para(b.text, { style: 'Heading1' }));
        break;
      case 'h2':
        out.push(para(b.text, { style: 'Heading2' }));
        break;
      case 'p':
        out.push(para(b.text, { spacing: '<w:spacing w:before="0" w:after="140"/>' }));
        break;
      case 'note':
        out.push(para(b.text, { style: 'Note' }));
        break;
      case 'list':
        for (const item of b.items) {
          out.push(
            para(`•  ${item}`, {
              spacing: '<w:spacing w:before="0" w:after="80"/>',
              indent: '<w:ind w:left="360" w:hanging="200"/>',
            }),
          );
        }
        break;
      case 'defs':
        out.push(table(b.rows, { widths: [0.24, 0.76], firstColBold: true }));
        break;
      case 'fields': {
        const rows = [];
        if (b.head) rows.push(b.head);
        rows.push(...b.rows);
        const cols = b.head ? b.head.length : b.rows[0].length;
        const widths = cols === 3 ? [0.32, 0.34, 0.34] : [0.32, 0.68];
        out.push(table(rows, { widths, headerRow: Boolean(b.head), firstColBold: true }));
        break;
      }
      case 'sign':
        out.push(signatureTable());
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

function documentXml(blocks) {
  const body = renderBlocks(blocks);
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

function footerXml() {
  const field = (instr) =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:pStyle w:val="Footer"/>' +
    '<w:tabs><w:tab w:val="right" w:pos="9070"/></w:tabs></w:pPr>' +
    run('Vehicle Rental Agreement — reference {{agreementReference}}') +
    '<w:r><w:tab/></w:r>' +
    run('Page ') +
    field('PAGE') +
    run(' of ') +
    field('NUMPAGES') +
    '</w:p></w:ftr>'
  );
}

function buildDocx(blocks) {
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
    `<dc:title>${esc(META.title)} — template</dc:title>` +
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
    { name: 'word/document.xml', data: Buffer.from(documentXml(blocks), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(footerXml(), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(app, 'utf8') },
  ];

  return makeZip(entries);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML rendering — a form the customer fills in and prints.
// ─────────────────────────────────────────────────────────────────────────────

function htmlField(key) {
  const f = field(key);
  const label = f ? f.label : key;
  const hint = f && f.hint ? f.hint : '';
  const len = f && f.len ? f.len : 24;
  const type = f && f.type ? f.type : 'text';
  const common =
    `class="field" name="${esc(key)}" aria-label="${esc(label)}" ` +
    `placeholder="${esc(hint)}" data-label="${esc(label)}"`;
  if (type === 'textarea') {
    return `<textarea ${common} rows="2"></textarea>`;
  }
  if (type === 'date') {
    return `<input type="date" ${common} size="${len}">`;
  }
  return `<input type="text" ${common} size="${len}">`;
}

function htmlText(text) {
  return splitTokens(text)
    .map((p) => (p.kind === 'field' ? htmlField(p.value) : esc(p.value)))
    .join('');
}

function htmlTable(rows, { widths, headerRow = false, firstColBold = false } = {}) {
  const cols = rows[0].length;
  const css = widths ?? (cols === 3 ? [32, 34, 34] : [32, 68]);
  const ths = rows
    .map(
      (cells, r) =>
        `<tr>${cells
          .map(
            (c, i) =>
              r === 0 && headerRow
                ? `<th style="width:${css[i]}%">${esc(c)}</th>`
                : `<td style="width:${css[i]}%">${htmlText(c)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  const body = firstColBold
    ? ths
    : ths;
  return `<table>${body}</table>`;
}

function htmlSignature() {
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

function renderHtmlBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'title':
        out.push(`<h1 class="doc-title">${esc(b.text)}</h1>`);
        break;
      case 'subtitle':
        out.push(`<p class="doc-subtitle">${esc(b.text)}</p>`);
        break;
      case 'meta':
        out.push(`<p class="doc-meta">${htmlText(b.text)}</p>`);
        break;
      case 'h1':
        out.push(`<h2>${esc(b.text)}</h2>`);
        break;
      case 'h2':
        out.push(`<h3>${esc(b.text)}</h3>`);
        break;
      case 'p':
        out.push(`<p>${htmlText(b.text)}</p>`);
        break;
      case 'note':
        out.push(`<p class="note">${esc(b.text)}</p>`);
        break;
      case 'list':
        out.push(`<ul>${b.items.map((i) => `<li>${htmlText(i)}</li>`).join('')}</ul>`);
        break;
      case 'defs':
        out.push(
          `<table>${b.rows
            .map(
              (r) =>
                `<tr><td class="term">${esc(r[0])}</td><td>${htmlText(r[1])}</td></tr>`,
            )
            .join('')}</table>`,
        );
        break;
      case 'fields': {
        const rows = b.head ? [b.head, ...b.rows] : b.rows;
        const cols = b.head ? b.head.length : b.rows[0].length;
        const widths = cols === 3 ? [32, 34, 34] : [32, 68];
        out.push(
          `<table>${rows
            .map((cells, r) =>
              r === 0 && b.head
                ? `<tr>${cells.map((c, i) => `<th style="width:${widths[i]}%">${esc(c)}</th>`).join('')}</tr>`
                : `<tr>${cells
                    .map((c, i) => `<td style="width:${widths[i]}%">${htmlText(c)}</td>`)
                    .join('')}</tr>`,
            )
            .join('')}</table>`,
        );
        break;
      }
      case 'sign':
        out.push(htmlSignature());
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

function buildHtml(blocks) {
  const groupList = GROUPS.map((g) => {
    const inputs = FIELDS.filter((f) => f.group === g.id)
      .map((f) => {
        const input = htmlField(f.key);
        return `<div class="fr"><label>${esc(f.label)}</label>${input}</div>`;
      })
      .join('');
    return `<details open><summary>${esc(g.label)}</summary><div class="fr-grid">${inputs}</div></details>`;
  }).join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(META.title)} — fillable template</title>
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
    <h2>${esc(META.title)} — fillable template</h2>
    <p>Fill in the highlighted fields below, then print to PDF. The printed copy carries no form styling.</p>
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
    <button type="button" class="secondary" id="clear">Clear all fields</button>
  </div>

  <div class="panel">
    <h3>Complete these details</h3>
    <p style="font-size:13px;color:var(--muted);margin:0 0 12px">
      Everything here also appears in the agreement below — you can fill it in either place.
      The “on return” column of Schedule 2 is completed by the Lessor when the vehicle comes back.
    </p>
    ${groupList}
  </div>

  <div class="paper">
${renderHtmlBlocks(blocks)}
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
// Run.
// ─────────────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const docxPath = path.join(OUT_DIR, META.docxFilename);
const htmlPath = path.join(OUT_DIR, META.htmlFilename);

writeFileSync(docxPath, buildDocx(BLOCKS));
writeFileSync(htmlPath, buildHtml(BLOCKS), 'utf8');

const used = new Set();
for (const b of BLOCKS) {
  const texts = [];
  if (b.text) texts.push(b.text);
  if (b.items) texts.push(...b.items);
  if (b.rows) for (const r of b.rows) texts.push(...r);
  if (b.head) texts.push(...b.head);
  for (const t of texts) {
    for (const m of String(t).matchAll(TOKEN_RE)) used.add(m[1]);
  }
}
const known = new Set([...FIELDS, ...RETURN_ONLY_FIELDS].map((f) => f.key));
const unknown = [...used].filter((k) => !known.has(k));
const unused = [...known].filter((k) => !used.has(k));

console.log(`Wrote ${docxPath}`);
console.log(`Wrote ${htmlPath}`);
console.log(`Fields used: ${used.size} of ${known.size}`);
if (unknown.length) {
  console.error(`\nUNKNOWN FIELD TOKENS (these would render as a raw {{token}}): ${unknown.join(', ')}`);
  process.exitCode = 1;
}
if (unused.length) {
  console.log(`Defined but not used: ${unused.join(', ')}`);
}
