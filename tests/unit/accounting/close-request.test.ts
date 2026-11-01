import { describe, expect, it } from 'vitest';
import {
  closeConfirmRequest,
  closePreflightRequest,
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
    const body = closeConfirmRequest('2026-10', ['open_bank_items']);
    expect(body.acknowledge).toEqual(['open_bank_items']);
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
