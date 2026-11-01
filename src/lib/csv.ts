/**
 * CSV cells, made safe for a spreadsheet.
 *
 * There are two separate dangers in a cell, and only one of them is fixed by
 * quoting:
 *
 *  1. **A cell that holds a comma, a quote or a newline breaks the row it is
 *     in.** RFC 4180's answer is to wrap the cell in quotes and double the
 *     quotes inside it.
 *
 *  2. **A cell that starts with `=`, `+`, `-` or `@` is not text to Excel or
 *     Sheets — it is something to run.** A rentee's name, a note pasted from a
 *     website, a tenant's trading name: each is data, and data that begins
 *     with `=` becomes a formula the moment someone opens the file. Quoting
 *     does **not** help here: a quoted cell whose content starts with `=` is
 *     still evaluated. The answer is a leading apostrophe, which the
 *     spreadsheet shows as part of the text and never runs.
 *
 * The apostrophe is only added to cells that are not already numbers. A
 * negative figure — `-£556.00`, `-1,234` — is a number, not a formula, and
 * prefixing it would turn it into text in the finance team's sheet, which is
 * the opposite of what the export is for.
 *
 * One helper, used by every export in the product: the rent-to-buy report and
 * the VAT return both write files that are opened in a spreadsheet.
 */

/**
 * A cell a spreadsheet would try to evaluate.
 *
 * The leading whitespace is included because it is what hides the trick: a
 * cell that reads `\t=1+1` looks innocent to a check that only looks at the
 * first character, and several CSV readers strip that whitespace before the
 * spreadsheet ever sees it.
 */
const FORMULA_LEAD = /^[\s]*[=+\-@]/;

/** A cell that starts with a tab or a carriage return is evaluated too. */
const WHITESPACE_LEAD = /^[\t\r]/;

/**
 * Whether the cell is a plain number.
 *
 * The shapes this product writes: `1,234`, `-1,234`, `12.34%`, `£1,234.56`,
 * `-£556.00`, `(1,234)` for an accounting negative. Anything else is text,
 * and text is what the apostrophe rule is for.
 */
function looksNumeric(value: string): boolean {
  let cleaned = value.replace(/\s/g, '').replace(/,/g, '');
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = cleaned.slice(1, -1);
  }
  cleaned = cleaned.replace(/%$/, '');
  // A currency symbol may sit on either side of the sign: -£5 and £-5 both
  // mean the same number to a person reading the cell.
  cleaned = cleaned.replace(/^([£$€])([+-])/, '$2$1');
  return /^[-+]?[£$€]?\d+(\.\d+)?$/.test(cleaned);
}

/** Wrap a cell in quotes and double the quotes inside it. */
function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * One CSV cell.
 *
 * Quotes what has to be quoted, and neutralises what would be run.
 */
export function csvCell(value: string): string {
  const raw = String(value ?? '');
  const dangerous =
    !looksNumeric(raw) && (FORMULA_LEAD.test(raw) || WHITESPACE_LEAD.test(raw));
  return quote(dangerous ? `'${raw}` : raw);
}

/** A row of cells, joined with commas. */
export function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}
