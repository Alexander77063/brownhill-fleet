/** One-line banner for `?notice=` after a redirect. Renders nothing otherwise. */
export function PlanNotice({ notice }: { notice: string | undefined }) {
  if (notice !== 'not-in-plan') return null;
  return (
    <p
      role="status"
      className="mb-4 rounded-md border border-hair bg-[var(--surface)] px-3 py-2 text-sm text-parchment"
    >
      That page is not included in your plan.
    </p>
  );
}
