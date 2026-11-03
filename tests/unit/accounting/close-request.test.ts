import { describe, expect, it } from 'vitest';
import {
  closeConfirmRequest,
  closePreflightRequest,
  parseAcknowledgements,
} from '@/lib/accounting/close-request';

describe('the close request bodies', () => {
  it('asks about a period without confirming anything', () => {
    // The route answers 428 on this body, with the counts and the warnings.
    // A `confirm` here would close the period without the operator ever
    // seeing them.
    expect(closePreflightRequest('2026-10')).toEqual({ period: '2026-10' });
    expect(closePreflightRequest('2026-10')).not.toHaveProperty('confirm');
  });

  it('carries the acknowledgements under the key the route reads', () => {
    // The route reads `body.acknowledge`. The client's state is called
    // `acknowledged`, and a shorthand `{ acknowledge }` sends
    // `acknowledge: undefined` — which the route reads as "nothing was
    // acknowledged" and refuses the close for ever.
    const body = closeConfirmRequest('2026-10', [
      { code: 'open_bank_items', count: 3, amountPence: 45_000 },
    ]);
    expect(body.acknowledge).toEqual([
      { code: 'open_bank_items', count: 3, amountPence: 45_000 },
    ]);
    expect(Object.keys(body)).toContain('acknowledge');
    expect(Object.keys(body)).not.toContain('acknowledged');
  });

  it('confirms, so the route knows this is not the first request', () => {
    expect(closeConfirmRequest('2026-10', []).confirm).toBe(true);
  });

  it('sends an empty list rather than nothing when there is nothing to acknowledge', () => {
    // A period with nothing outstanding closes with an empty list. The key
    // has to be present for the route to be able to tell "acknowledged
    // nothing, there was nothing" from "did not say".
    const body = closeConfirmRequest('2026-10', []);
    expect(body.acknowledge).toEqual([]);
    expect(Object.keys(body)).toContain('acknowledge');
  });

  it('carries the period in the format the route parses', () => {
    // The route accepts exactly 'YYYY-MM' and refuses anything else, so a
    // body built from a Date or a localised string would be a 400.
    expect(closeConfirmRequest('2026-10', []).period).toBe('2026-10');
    expect(closePreflightRequest('2026-01').period).toBe('2026-01');
  });
});

describe('reading the acknowledgements out of an untrusted body', () => {
  it('accepts a well-formed acknowledgement', () => {
    expect(
      parseAcknowledgements([
        { code: 'open_bank_items', count: 3, amountPence: 45_000 },
      ]),
    ).toEqual([{ code: 'open_bank_items', count: 3, amountPence: 45_000 }]);
  });

  it('drops anything that is not an acknowledgement of a known warning', () => {
    // The body is JSON from a browser. A dropped acknowledgement makes the
    // close refuse, which is the safe direction; a coerced one would let a
    // malformed body acknowledge something the operator never saw.
    expect(parseAcknowledgements('open_bank_items')).toEqual([]);
    expect(parseAcknowledgements(null)).toEqual([]);
    expect(parseAcknowledgements(undefined)).toEqual([]);
    expect(parseAcknowledgements([null])).toEqual([]);
    expect(parseAcknowledgements(['open_bank_items'])).toEqual([]);
    expect(parseAcknowledgements([{ code: 'made_up_warning', count: 1, amountPence: 1 }])).toEqual([]);
  });

  it('drops an acknowledgement whose figures are not numbers', () => {
    expect(
      parseAcknowledgements([{ code: 'open_bank_items', count: 'three', amountPence: 45_000 }]),
    ).toEqual([]);
    expect(
      parseAcknowledgements([{ code: 'open_bank_items', count: 3, amountPence: null }]),
    ).toEqual([]);
    expect(
      parseAcknowledgements([{ code: 'open_bank_items', count: Number.NaN, amountPence: 1 }]),
    ).toEqual([]);
  });

  it('drops an acknowledgement with negative figures', () => {
    // No real warning has a negative count or a negative amount. One that
    // did could be "acknowledged" by a figure that was never on screen.
    expect(
      parseAcknowledgements([{ code: 'open_bank_items', count: -1, amountPence: 45_000 }]),
    ).toEqual([]);
    expect(
      parseAcknowledgements([{ code: 'open_bank_items', count: 3, amountPence: -1 }]),
    ).toEqual([]);
  });

  it('keeps the good entries and drops the bad ones', () => {
    expect(
      parseAcknowledgements([
        { code: 'open_bank_items', count: 3, amountPence: 45_000 },
        { code: 'vat_not_filed', count: 'one', amountPence: 1 },
        'nonsense',
      ]),
    ).toEqual([{ code: 'open_bank_items', count: 3, amountPence: 45_000 }]);
  });
});
