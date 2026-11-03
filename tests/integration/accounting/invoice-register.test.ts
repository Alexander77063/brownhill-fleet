// tests/integration/accounting/invoice-register.test.ts
//
// The invoice register, against a real postgres.
//
// WHAT THIS FILE EXISTS FOR
// -------------------------
// The register is the list every finance conversation starts from: which
// invoices have we issued, which are paid, which are still owed. It is also
// the surface the void lives on, so if it does not load, the void is
// unreachable.
//
// IT EXISTS BECAUSE THE REGISTER 500s
// -----------------------------------
// The status filter was written as
//
//     and (${status} = 'all' or i.status = ${status}::invoice_status)
//
// with ONE bound parameter used twice. Postgres resolves a parameter's type
// from the context that constrains it, and the explicit cast to
// `invoice_status` is what constrains it — so the parameter is bound as an
// `invoice_status`, and the value 'all' is not a member of that enum. Every
// call with the default filter died with
//
//     invalid input value for enum invoice_status: "all"
//
// and the register pages answered HTTP 500.
//
// The lesson is written into the test rather than left in the fix: the filter
// has to work for every status the enum has, including the ones the product
// adds later, and the 'all' filter must not be a special case that has to be
// remembered.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { countInvoicesByStatus, listInvoices } from '@/lib/accounting/invoice-register';
import type { InvoiceStatus } from '@/lib/accounting/invoice-shared';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the invoice-register tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

describe.skipIf(!DATABASE_URL)('the invoice register, against a real postgres', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const slug = `register-${tenantId.slice(0, 8)}`;

  let agreementId: string;

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Invoice register test', ${slug})
    `;
    await sql`
      insert into public.tenants (id, name, slug)
      values (${otherTenantId}::uuid, 'Someone else', ${`other-${otherTenantId.slice(0, 8)}`})
    `;

    const driverId = randomUUID();
    const vehicleId = randomUUID();
    agreementId = randomUUID();

    await sql`
      insert into public.drivers (id, full_name, email, status, tenant_id)
      values (${driverId}::uuid, 'Register Driver', ${`driver-${driverId}@brownhill.test`},
              'active', ${tenantId}::uuid)
    `;
    await sql`
      insert into public.vehicles
        (id, registration, make, model, fuel, list_value_pence, status, tenant_id)
      values (${vehicleId}::uuid, ${`RG${vehicleId.slice(0, 6).toUpperCase()}`},
              'Mercedes-Benz', 'S580e 4MATIC Long', 'phev', 11700000,
              'on_hire', ${tenantId}::uuid)
    `;
    await sql`
      insert into public.agreements
        (id, type, vehicle_id, driver_id, status, start_date,
         weekly_gross_pence, weekly_net_pence, weekly_vat_pence, tenant_id)
      values (${agreementId}::uuid, 'standard', ${vehicleId}::uuid, ${driverId}::uuid,
              'active', '2026-01-05', 12000, 10000, 2000, ${tenantId}::uuid)
    `;

    // One invoice in each status the enum has, so the filter is exercised
    // against all of them rather than against the one the page happens to
    // open on.
    const statuses: InvoiceStatus[] = ['open', 'paid', 'part_paid', 'void', 'overdue'];
    for (const [index, status] of statuses.entries()) {
      await sql`
        insert into public.invoices
          (tenant_id, agreement_id, number, issued_on, due_on,
           gross_pence, net_pence, vat_pence, status)
        values (${tenantId}::uuid, ${agreementId}::uuid,
                ${`REG-${status.toUpperCase()}-0001`}, ${`2026-01-${String(index + 10).padStart(2, '0')}`}::date,
                ${`2026-01-${String(index + 10).padStart(2, '0')}`}::date,
                12000, 10000, 2000, ${status}::public.invoice_status)
      `;
    }

    // Another tenant's invoice, which must never appear in this tenant's
    // register — the accounting schema bypasses RLS, so the tenant predicate
    // in the query is the only thing keeping it out.
    const otherDriverId = randomUUID();
    const otherVehicleId = randomUUID();
    const otherAgreementId = randomUUID();
    await sql`
      insert into public.drivers (id, full_name, email, status, tenant_id)
      values (${otherDriverId}::uuid, 'Other Driver', ${`other-${otherDriverId}@brownhill.test`},
              'active', ${otherTenantId}::uuid)
    `;
    await sql`
      insert into public.vehicles
        (id, registration, make, model, fuel, list_value_pence, status, tenant_id)
      values (${otherVehicleId}::uuid, ${`OG${otherVehicleId.slice(0, 6).toUpperCase()}`},
              'Mercedes-Benz', 'S580e 4MATIC Long', 'phev', 11700000,
              'on_hire', ${otherTenantId}::uuid)
    `;
    await sql`
      insert into public.agreements
        (id, type, vehicle_id, driver_id, status, start_date,
         weekly_gross_pence, weekly_net_pence, weekly_vat_pence, tenant_id)
      values (${otherAgreementId}::uuid, 'standard', ${otherVehicleId}::uuid, ${otherDriverId}::uuid,
              'active', '2026-01-05', 12000, 10000, 2000, ${otherTenantId}::uuid)
    `;
    await sql`
      insert into public.invoices
        (tenant_id, agreement_id, number, issued_on, due_on,
         gross_pence, net_pence, vat_pence, status)
      values (${otherTenantId}::uuid, ${otherAgreementId}::uuid, 'REG-OTHER-0001',
              '2026-01-10'::date, '2026-01-10'::date, 12000, 10000, 2000,
              'open'::public.invoice_status)
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.payment_allocations where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.payments where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.invoices where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.agreements where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.vehicles where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.drivers where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.invoices where tenant_id = ${otherTenantId}::uuid`;
    await sql`delete from public.agreements where tenant_id = ${otherTenantId}::uuid`;
    await sql`delete from public.vehicles where tenant_id = ${otherTenantId}::uuid`;
    await sql`delete from public.drivers where tenant_id = ${otherTenantId}::uuid`;
    await sql`delete from public.tenants where id in (${tenantId}::uuid, ${otherTenantId}::uuid)`;
  });

  it('lists every invoice when no status is asked for', async () => {
    // This is the call the register pages make. It used to answer 500.
    const rows = await listInvoices(tenantId);

    expect(rows.length, 'the register returned fewer invoices than exist').toBe(5);
    expect(rows.map((r) => r.number).sort()).toEqual([
      'REG-OPEN-0001',
      'REG-OVERDUE-0001',
      'REG-PAID-0001',
      'REG-PART_PAID-0001',
      'REG-VOID-0001',
    ]);
  });

  it('lists every invoice when "all" is asked for explicitly', async () => {
    const rows = await listInvoices(tenantId, { status: 'all' });
    expect(rows.length).toBe(5);
  });

  it('filters by status, one status at a time', async () => {
    for (const status of ['open', 'paid', 'part_paid', 'void', 'overdue'] as InvoiceStatus[]) {
      const rows = await listInvoices(tenantId, { status });
      expect(rows.length, `${status} did not return exactly one invoice`).toBe(1);
      expect(rows[0].status).toBe(status);
    }
  });

  it('never shows another tenant an invoice', async () => {
    const rows = await listInvoices(tenantId);
    expect(rows.map((r) => r.number)).not.toContain('REG-OTHER-0001');

    const open = await listInvoices(tenantId, { status: 'open' });
    expect(open.map((r) => r.number)).not.toContain('REG-OTHER-0001');
  });

  it('counts every invoice in each status, not just the ones on screen', async () => {
    const counts = await countInvoicesByStatus(tenantId);

    expect(counts.open).toBe(1);
    expect(counts.paid).toBe(1);
    expect(counts.part_paid).toBe(1);
    expect(counts.void).toBe(1);
    expect(counts.overdue).toBe(1);
  });

  it('says how much of an invoice is still outstanding after a payment', async () => {
    const rows = await listInvoices(tenantId, { status: 'open' });
    const invoice = rows[0];
    expect(invoice.allocated_pence).toBe('0');

    const paymentRows = (await sql`
      insert into public.payments
        (tenant_id, agreement_id, source, idempotency_key,
         amount_pence, received_on, status)
      values (${tenantId}::uuid, ${agreementId}::uuid, 'manual',
              ${`register-paid-${invoice.id}`}, 4000, '2026-02-01'::date, 'confirmed')
      returning id
    `) as Array<{ id: string }>;
    const paymentId = paymentRows[0].id;

    await sql`
      insert into public.payment_allocations (tenant_id, payment_id, invoice_id, amount_pence)
      values (${tenantId}::uuid, ${paymentId}::uuid, ${invoice.id}::uuid, 4000)
    `;

    // The database keeps invoice.status in step with what has been allocated
    // against it — the sync_invoice_status trigger, since migration 0006. So
    // a partly-paid invoice is a 'part_paid' invoice, and the register has to
    // show it there rather than still listing it as open.
    const partPaid = await listInvoices(tenantId, { status: 'part_paid' });
    const moved = partPaid.find((r) => r.number === invoice.number);
    expect(moved, 'the partly-paid invoice is not listed as part_paid').toBeTruthy();
    expect(moved!.allocated_pence).toBe('4000');
    expect(moved!.status).toBe('part_paid');

    const open = await listInvoices(tenantId, { status: 'open' });
    expect(open.map((r) => r.number)).not.toContain(invoice.number);

    // Put it back, so this test does not depend on the order the others run
    // in — the counts are asserted from the same fixture.
    await sql`delete from public.payment_allocations where payment_id = ${paymentId}::uuid`;
    await sql`delete from public.payments where id = ${paymentId}::uuid`;

    const restored = await listInvoices(tenantId, { status: 'open' });
    expect(restored.map((r) => r.number)).toContain(invoice.number);
    expect(restored.find((r) => r.number === invoice.number)!.allocated_pence).toBe('0');
  });
});
