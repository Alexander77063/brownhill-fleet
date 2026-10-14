'use client';

// /ops/expenses/ExpenseRecordForm — small Client Component that wraps the
// record-an-expense form so it can reset after a successful save
// (the Save & add another button) and so the prefilled Duplicate flow
// produces controlled inputs the user can scrub before saving.

import { useRef, useEffect } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';
import { recordExpenseAction, type RecordExpenseResult } from '@/lib/actions/expenses';

const initial: RecordExpenseResult = { ok: false, intent: 'save' };

type CategoryOpt = { id: string; name: string };
type VehicleOpt  = { id: string; registration: string };

export interface ExpenseRecordFormProps {
  categories: readonly CategoryOpt[];
  vehicles:   readonly VehicleOpt[];
  prefill: {
    category_id: string | null;
    vehicle_id:  string | null;
    amount_pence: number;
    incurred_on: string;
    description: string | null;
  } | null;
}

function penceToPounds(pence: number): string {
  // Always show with two decimals so the user knows it's the pounds value
  // — we'll re-parse on submit.
  return (pence / 100).toFixed(2);
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="sm" disabled={pending}>
      {pending ? 'Recording…' : label}
    </Button>
  );
}

export function ExpenseRecordForm({ categories, vehicles, prefill }: ExpenseRecordFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action] = useFormState<RecordExpenseResult, FormData>(
    async (_prev, fd) => recordExpenseAction(fd),
    initial,
  );

  // Save & add another: clear the form so the next entry is a fresh row.
  useEffect(() => {
    if (state.ok && state.intent === 'add-another') {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      // re-rendering on prefill change so the inputs pick up defaultValue
      key={prefill ? `prefill-${prefill.amount_pence}-${prefill.incurred_on}` : 'fresh'}
      className="mt-3 space-y-2"
    >
      <select
        name="category_id"
        aria-label="Expense category"
        className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
        defaultValue={prefill?.category_id ?? ''}
      >
        <option value="">Uncategorised</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <select
        name="vehicle_id"
        aria-label="Vehicle this expense relates to"
        className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
        defaultValue={prefill?.vehicle_id ?? ''}
      >
        <option value="">No vehicle</option>
        {vehicles.map((v) => (
          <option key={v.id} value={v.id}>{v.registration}</option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <input
          name="amount"
          required
          inputMode="decimal"
          placeholder="Amount (£)"
          aria-label="Amount in pounds"
          className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
          defaultValue={prefill ? penceToPounds(prefill.amount_pence) : ''}
        />
        <input
          name="incurred_on"
          type="date"
          aria-label="Date incurred"
          className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
          defaultValue={prefill?.incurred_on ?? ''}
        />
      </div>
      <input
        name="description"
        placeholder="Description (optional)"
        aria-label="Description"
        className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none"
        defaultValue={prefill?.description ?? ''}
      />
      <label className="block">
        <span className="mb-1 block text-xs text-parchment">Receipt photo (optional)</span>
        <input
          name="receipt"
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          className="rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none file:mr-2 file:rounded file:border-0 file:bg-navy-2 file:px-2 file:py-1 file:text-xs file:text-cream"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton label="Record expense" />
        <button
          type="submit"
          name="intent"
          value="add-another"
          className="rounded-md border border-hair-soft bg-[var(--surface)] px-3 py-1 text-xs text-cream hover:bg-[var(--surface-2)]"
        >
          Save &amp; add another
        </button>
        {prefill && (
          <span className="text-xs text-gold-bright">Prefilled from a duplicate — edit and save.</span>
        )}
      </div>
    </form>
  );
}
