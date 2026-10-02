import Link from "next/link";
import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface OnboardingChecklistItem {
  key: string;
  label: string;
  done: boolean;
  href: string;
  /** Optional steps are shown but don't count toward completion. */
  optional?: boolean;
}

/** Getting-started setup guide shown on the dashboard homes. Presentational and
 *  server-safe. Shows a live completion counter + progress bar while required steps
 *  remain, and an explicit "Setup complete" confirmation once they're all done
 *  (rather than silently vanishing), so the operator always knows where they stand.
 *  Optional steps (e.g. inviting a team) are listed but never block completion. */
export function OnboardingChecklist({
  title,
  items,
}: {
  title: string;
  items: OnboardingChecklistItem[];
}) {
  if (items.length === 0) return null;

  const required = items.filter((i) => !i.optional);
  const optional = items.filter((i) => i.optional);
  const total = required.length;
  const doneCount = required.filter((i) => i.done).length;
  const remaining = total - doneCount;
  const pct = total === 0 ? 100 : Math.round((doneCount / total) * 100);
  const complete = remaining === 0;

  const Row = ({ item }: { item: OnboardingChecklistItem }) => (
    <li className="flex items-center gap-2.5 text-sm">
      <span className={item.done ? "text-[var(--color-profit)]" : "text-muted"} aria-hidden>
        {item.done ? "✓" : "○"}
      </span>
      <Link
        href={item.href}
        className={
          item.done
            ? "text-muted line-through decoration-hair-soft hover:text-parchment"
            : "font-medium text-cream hover:text-gold-bright"
        }
      >
        {item.label}
      </Link>
      {item.optional && <span className="text-[11px] uppercase tracking-wider text-muted">optional</span>}
      {!item.done && (
        <Link
          href={item.href}
          className="ml-auto text-xs font-semibold text-gold-bright transition hover:underline"
        >
          Set up →
        </Link>
      )}
    </li>
  );

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>{complete ? "Setup complete" : title}</CardTitle>
        <span
          className={
            complete
              ? "inline-flex items-center gap-1 rounded-full border border-[var(--color-profit)] px-2.5 py-0.5 text-xs font-semibold text-[var(--color-profit)]"
              : "inline-flex items-center gap-1 rounded-full border border-hair-soft px-2.5 py-0.5 text-xs font-semibold text-gold-bright tnum"
          }
        >
          {complete ? (
            <>
              <Icon name="check" className="h-3.5 w-3.5" /> All done
            </>
          ) : (
            `${doneCount} / ${total}`
          )}
        </span>
      </div>

      {complete ? (
        <div
          className="mt-3 flex items-start gap-3 rounded-[var(--radius)] border border-[var(--color-profit)] px-4 py-3"
          style={{ background: "rgba(76, 175, 125, 0.12)" }}
        >
          <span className="mt-0.5 text-[var(--color-profit)]">
            <Icon name="check" />
          </span>
          <p className="text-sm text-parchment">
            Every required step is done — your fleet is ready to run. You can revisit any of these
            from Settings at any time.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted tnum">
                {doneCount} of {total} steps complete
              </span>
              <span className="font-semibold text-gold-bright tnum">{remaining} remaining</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-strong)]">
              <div
                className="h-full rounded-full bg-gold-bright transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <ul className="mt-4 space-y-1.5">
            {required.map((item) => (
              <Row key={item.key} item={item} />
            ))}
          </ul>
        </>
      )}

      {optional.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-hair-soft pt-3">
          {optional.map((item) => (
            <Row key={item.key} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export default OnboardingChecklist;
