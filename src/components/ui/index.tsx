import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatGBP } from '@/lib/money';
import { HelpHint } from '@/components/HelpHint';
import type { HelpKey } from '@/lib/help-content';

/* ── Eyebrow / section label ─────────────────────────────────────────────── */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('eyebrow', className)}>{children}</p>;
}

/* ── Page header ─────────────────────────────────────────────────────────── */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  help,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  /** Optional ⓘ help key rendered beside the title (what this is / how to set up). */
  help?: HelpKey;
}) {
  return (
    <header className="reveal mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-1 flex items-center gap-2 text-3xl text-cream sm:text-4xl">
          {title}
          {help && <HelpHint id={help} label={title} />}
        </h1>
        <div className="gold-rule mt-3" />
        {subtitle && <p className="mt-3 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

/* ── Card ────────────────────────────────────────────────────────────────── */
export function Card({
  children,
  className,
  as: As = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  as?: React.ElementType;
}) {
  return <As className={cn('card-surface p-5', className)}>{children}</As>;
}

/**
 * Section heading inside a Card.
 *
 * Defaults to <h2> because pages render a single <h1> in <PageHeader>; the previous
 * hardcoded <h3> skipped a level, which screen-reader users navigating by heading
 * experience as a missing section (WCAG 1.3.1). Pass `as` when genuinely nesting deeper.
 */
export function CardTitle({
  children,
  className,
  as: As = 'h2',
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'h2' | 'h3' | 'h4';
}) {
  return <As className={cn('text-lg text-cream', className)}>{children}</As>;
}

/* ── KPI stat ────────────────────────────────────────────────────────────── */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'profit' | 'loss' | 'warn' | 'gold';
  className?: string;
}) {
  const toneClass = {
    default: 'text-cream',
    profit: 'text-[var(--color-profit)]',
    loss: 'text-[var(--color-loss)]',
    warn: 'text-[var(--color-warn)]',
    gold: 'text-gold-bright',
  }[tone];
  return (
    <Card className={cn('flex flex-col justify-between', className)}>
      <Eyebrow className="text-parchment">{label}</Eyebrow>
      <p className={cn('mt-3 font-display text-3xl tnum', toneClass)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

/* ── Money ───────────────────────────────────────────────────────────────── */
export function Money({
  pence,
  className,
  showPence = true,
  signed = false,
}: {
  pence: number;
  className?: string;
  showPence?: boolean;
  signed?: boolean;
}) {
  const tone = signed ? (pence < 0 ? 'text-[var(--color-loss)]' : 'text-[var(--color-profit)]') : '';
  const prefix = signed && pence > 0 ? '+' : '';
  return <span className={cn('tnum', tone, className)}>{prefix}{formatGBP(pence, { showPence })}</span>;
}

/* ── Badge / status pill ─────────────────────────────────────────────────── */
const BADGE_TONES: Record<string, string> = {
  neutral: 'border-hair-soft text-parchment',
  gold: 'border-[var(--color-gold)] text-gold-bright',
  profit: 'border-[var(--color-profit)] text-[var(--color-profit)]',
  loss: 'border-[var(--color-loss)] text-[var(--color-loss)]',
  warn: 'border-[var(--color-warn)] text-[var(--color-warn)]',
  info: 'border-[var(--color-info)] text-[var(--color-info)]',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof BADGE_TONES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Button ──────────────────────────────────────────────────────────────── */
type ButtonProps = {
  children: React.ReactNode;
  variant?: 'primary' | 'ghost' | 'outline';
  size?: 'sm' | 'md';
  href?: string;
  /** For link buttons: open in a new tab (adds a safe rel). */
  target?: React.HTMLAttributeAnchorTarget;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ children, variant = 'primary', size = 'md', href, target, className, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] font-semibold transition-all duration-200 focus-visible:outline-2';
  const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2.5 text-sm' }[size];
  const variants = {
    primary:
      'bg-gradient-to-b from-gold-bright to-gold text-on-gold hover:brightness-110 hover:-translate-y-px shadow-[0_4px_18px_-6px_rgba(184,151,42,0.6)]',
    outline: 'border border-hair text-gold-bright hover:bg-[rgba(184,151,42,0.08)]',
    ghost: 'text-parchment hover:text-cream hover:bg-[var(--surface)]',
  }[variant];
  const cls = cn(base, sizes, variants, className);
  if (href) {
    return (
      <Link
        href={href}
        className={cls}
        target={target}
        rel={target === '_blank' ? 'noopener noreferrer' : undefined}
      >
        {children}
      </Link>
    );
  }
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}

/* ── Table primitives ────────────────────────────────────────────────────── */
/**
 * Data table in a horizontally scrollable shell.
 *
 * The wrapper is focusable: a scroll container that only responds to a mouse wheel or
 * drag strands keyboard-only users on narrow viewports (WCAG 2.1.1 Keyboard, Level A).
 * Give every table a `caption` — it is visually hidden but gives screen-reader users the
 * table's purpose when they land on it, and names the scrollable region.
 */
export function Table({
  children,
  className,
  caption,
}: {
  children: React.ReactNode;
  className?: string;
  /** Required: names the table for assistive technology via a visually-hidden <caption>. */
  caption: string;
}) {
  return (
    // tabIndex makes the overflow container reachable by keyboard (WCAG 2.1.1); the rule's
    // allow-list only covers `tabpanel`. Deliberately NOT role="region": `region` is a
    // landmark, and naming 41 table wrappers would inject 41 landmarks into the rota — on
    // a page with four tables a screen-reader user would cycle through all of them. The
    // <caption> already names the table, which is what AT actually needs here.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className={cn('card-surface overflow-x-auto', className)} tabIndex={0}>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

/**
 * Column header. `scope="col"` is what lets a screen reader announce the column name
 * when reading each cell — without it a wide finance table is just a stream of numbers
 * (WCAG 1.3.1 Info and Relationships, Level A).
 */
export function Th({
  children,
  className,
  scope = 'col',
}: {
  children: React.ReactNode;
  className?: string;
  scope?: 'col' | 'row';
}) {
  return (
    <th
      scope={scope}
      className={cn(
        'whitespace-nowrap px-4 py-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--color-gold-text)]',
        className,
      )}
    >
      {children}
    </th>
  );
}
export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('whitespace-nowrap border-t border-hair-soft px-4 py-3 text-parchment', className)}>{children}</td>;
}

/* ── Empty state ─────────────────────────────────────────────────────────── */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="flex flex-col items-center justify-center py-12 text-center">
      <div className="gold-rule mb-4" />
      <p className="text-cream">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </Card>
  );
}
