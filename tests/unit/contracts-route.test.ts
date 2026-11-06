// tests/unit/contracts-route.test.ts
//
// The contract route: what the operator gets when they generate an
// agreement.
//
// WHY THIS FILE EXISTS
// --------------------
// The route used to read a document out of `docs/business/`, a directory this
// repository does not have. Every contract the operator generated answered
// `500 {"error":"template unavailable"}` — the whole feature was dead on
// arrival, and the failure was a five-hundred in the browser rather than
// anything the operator could act on.
//
// The route now reads the fork's own documents out of `docs/contracts/` and
// fills them from the database. Three things about that are worth pinning:
//
//   * the wrong answer to a missing agreement (404, not an empty document);
//   * the identity gate — a contract carries the TENANT's details, so it must
//     not be issued at all until the tenant has set them;
//   * the outstanding list — the particulars that are still blank, so the
//     operator knows what to complete before the agreement goes out.
//
// The database is faked; the documents, the gate, the filling and the
// outstanding list are all REAL, because those are the contract worth
// testing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const AGREEMENT_ID = '11111111-2222-3333-4444-555555555555';

const h = vi.hoisted(() => ({
  state: {
    agreement: null as Record<string, unknown> | null,
    vehicle: null as Record<string, unknown> | null,
    driver: null as Record<string, unknown> | null,
    certs: [] as Record<string, unknown>[],
    branding: {} as Record<string, unknown>,
  },
}));

/**
 * The faked database.
 *
 * The route names the table it is asking about in every statement, so the
 * fake answers on the table name. The chain is thenable as well as
 * `maybeSingle`-able, because the insurance certificates are awaited
 * directly while the agreement is fetched one row at a time.
 */
function makeClient() {
  const tableData = (table: string): unknown => {
    switch (table) {
      case 'agreements':
        return h.state.agreement;
      case 'vehicles':
        return h.state.vehicle;
      case 'drivers':
        return h.state.driver;
      case 'insurance_certificates':
        return h.state.certs;
      default:
        return null;
    }
  };
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.maybeSingle = async () => ({ data: tableData(table) });
    c.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve({ data: tableData(table) }).then(resolve, reject);
    return c;
  };
  return { from: (table: string) => chain(table) };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeClient(),
  createServiceClient: () => makeClient(),
}));

// Only `getBranding` is faked. The completeness check that decides whether a
// contract may be issued at all is the real one.
vi.mock('@/lib/branding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/branding')>();
  return { ...actual, getBranding: async () => h.state.branding };
});

import { GET } from '@/app/api/contracts/[agreementId]/route';

const params = (id: string) => ({ params: Promise.resolve({ agreementId: id }) });

const request = (id: string, search = ''): Request =>
  new Request(`https://fleet.example/api/contracts/${id}${search}`);

const STANDARD_AGREEMENT = {
  id: AGREEMENT_ID,
  type: 'standard',
  vehicle_id: 'v1',
  driver_id: 'd1',
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
  // The internal cost of the car. It must never reach a customer.
  agreed_vehicle_cost_pence: 1_500_000,
  excess_mile_pence: 100,
};

const RTB_AGREEMENT = {
  ...STANDARD_AGREEMENT,
  type: 'rtb',
  term_weeks: 156,
  term_months: 36,
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

const VEHICLE = {
  id: 'v1',
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
  id: 'd1',
  full_name: 'Jane Doe',
  address: '1 High Street, London N1 1AA',
  date_of_birth: '1990-01-01',
  phone: '07700 900000',
  email: 'jane@example.com',
  pco_licence_no: 'PCO123456',
  dvla_licence_no: null,
};

const COMPLETE_BRANDING = {
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

beforeEach(() => {
  h.state.agreement = { ...STANDARD_AGREEMENT };
  h.state.vehicle = { ...VEHICLE };
  h.state.driver = { ...DRIVER };
  h.state.certs = [];
  h.state.branding = { ...COMPLETE_BRANDING };
});

describe('the contract route', () => {
  it('answers 404 for an agreement that does not exist', async () => {
    h.state.agreement = null;
    const res = await GET(request('nope') as never, params('nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('agreement not found');
  });

  it('refuses to issue a contract before the tenant has set their identity', async () => {
    // A contract carries the tenant's own details. Issuing one with the
    // platform's details on it would put the wrong company on a legal
    // document, so the answer is a stop page that says what is missing.
    h.state.branding = { ...COMPLETE_BRANDING, address: '' };
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Registered address');
    expect(html).toContain('/admin/branding');
    // and no document was issued
    expect(html).not.toContain('Vehicle Rental Agreement');
  });

  it('issues the filled document', async () => {
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();

    // the customer's particulars, from the database
    expect(html).toContain('Jane Doe');
    expect(html).toContain('AB12 CDE');
    expect(html).toContain('£200.00');
    // the Lessor's particulars, from the tenant's own branding
    expect(html).toContain('Brownhill Fleet Ltd');
    expect(html).toContain('QBE');
  });

  it('never puts the internal cost of the vehicle on a customer contract', async () => {
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    const html = await res.text();
    // £15,000 is what the car cost Brownhill. It is not the customer's
    // business and must never appear on their agreement.
    expect(html).not.toContain('£15,000.00');
    expect(html).not.toContain('1500000');
  });

  it('tells the operator what is still to be completed', async () => {
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    const html = await res.text();
    expect(html).toContain('Still to be completed');
    // the odometer is read at handover, so it is listed under handover and
    // not as something to do before the agreement is signed
    expect(html).toContain('vehicleMileage');
    expect(html).toContain('Completed at handover');
  });

  it('keeps the outstanding notice off the printed copy', async () => {
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    const html = await res.text();
    expect(html).toContain('@media print');
    expect(html).toContain('.outstanding{display:none!important}');
  });

  it('offers a completed copy to download', async () => {
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    const html = await res.text();
    expect(html).toContain('Download completed copy');
    expect(html).toContain('__downloadFilledContract');
  });

  it('serves the self-insured edition when the customer holds their own policy', async () => {
    h.state.certs = [
      {
        status: 'verified',
        insurer: 'Aviva',
        policy_no: 'AV123456',
        cover_from: '2026-01-01',
        cover_to: '2027-01-01',
        company_interested_party: false,
      },
    ];
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    const html = await res.text();
    // the customer's own insurer and policy are on the document
    expect(html).toContain('Aviva');
    expect(html).toContain('AV123456');
    // and Brownhill's fleet policy is not, because the customer's policy is
    // the one that covers this vehicle
    expect(html).not.toContain('QBE999');
  });

  it('issues the rent-to-buy for a rent-to-buy, with the rate of credit', async () => {
    h.state.agreement = { ...RTB_AGREEMENT };
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Rent-to-Buy');
    expect(html).toContain('% APR');
    // the buyout balance the customer has to pay
    expect(html).toContain('£4,650.00');
    // and the option credit, quoted at Brownhill's published weekly figure
    expect(html).toContain('£162.50');
  });

  it('downloads as a file when asked to', async () => {
    const res = await GET(request(AGREEMENT_ID, '?download=1') as never, params(AGREEMENT_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="agreement-standard-${AGREEMENT_ID.slice(0, 8)}.html"`,
    );
  });

  it('is a web page rather than a download unless asked', async () => {
    const res = await GET(request(AGREEMENT_ID) as never, params(AGREEMENT_ID));
    expect(res.headers.get('content-disposition')).toBeNull();
  });
});
