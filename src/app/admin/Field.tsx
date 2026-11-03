/**
 * The admin page's form primitives.
 *
 * They live here because the add-a-member form is a CLIENT component — it
 * needs `useActionState` to show the operator the temporary password it is
 * handed — while the rest of the page is a server component. One definition,
 * used by both.
 */

export const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
