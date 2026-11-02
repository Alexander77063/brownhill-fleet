// src/lib/accounting/json.ts
//
// Making the accounting module's answers safe to put on the wire.
//
// THE BUG THIS EXISTS FOR
// -----------------------
// Every pence figure in the accounting module is a BigInt. They are money,
// and money is not a float: 12000 pence is £120.00, and a JavaScript number
// cannot be trusted to hold that exactly in every consumer that reads it.
//
// `JSON.stringify` — which is what `NextResponse.json` calls — THROWS on a
// BigInt:
//
//     TypeError: Do not know how to serialize a BigInt
//
// So a route that returned a report object directly answered 500 with that
// message, every time, for every tenant:
//
//     GET /api/v1/accounting/reports/pnl        → 500
//     GET /api/v1/accounting/reports/balance-sheet → 500
//     GET /api/v1/accounting/reports/cashflow   → 500
//     GET /api/v1/accounting/reports/ar-aging   → 500
//
// The screens in `src/app/admin/accounting/reports/*` are server-rendered and
// format the figures themselves, so the operator's own view of the books was
// never broken — which is why nobody noticed. The JSON API was dead, and the
// accountant export flow that is meant to read it had nothing to read.
//
// The bank import route had the same defect, and it was worse there: its
// success return sits OUTSIDE its try/catch, so a successful import — rows
// written, money in — answered 500 with the BigInt error. The operator was
// told their import failed when it had worked, and would import it again.
//
// WHAT THIS DOES
// --------------
// A pence figure crosses the wire as a STRING, not a number. That is the
// convention the void route already used (`refundPence:
// result.refundPence.toString()`), and it is the right one: £120.00 is 12000
// pence, and a JSON consumer that divides by 100 wants a value it cannot
// round. A string says exactly what it is.
//
// The conversion happens at the WIRE BOUNDARY and nowhere else. The
// accounting library keeps its precise BigInt types internally, where they
// are arithmetic, and the route converts on the way out. A BigInt that never
// leaves the process is not a problem to solve; a BigInt that reaches
// `JSON.stringify` is.

/**
 * Convert a value into something `JSON.stringify` can handle.
 *
 * BigInts become strings — the representation every pence figure uses on the
 * wire. Everything else is left alone: strings, numbers, booleans and null
 * are already fine, arrays and plain objects are walked, and Date objects are
 * passed through so that `JSON.stringify` can call their own `toJSON` and
 * produce the ISO string a consumer expects.
 *
 * Class instances are walked as plain objects, which drops their prototype.
 * That is deliberate: the point of this helper is to produce a value
 * `JSON.stringify` will accept, and a plain object is what it accepts. The
 * accounting module's own types are interfaces over plain data, so nothing
 * is lost.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(item);
    }
    return out;
  }
  return value;
}
