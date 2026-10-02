'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { deploymentBrand } from '@/lib/deployment/brand';
import type { NavItem } from './nav';
import type { UserRole } from '@/lib/supabase/database.types';
import type { Theme } from '@/lib/theme';

/** Shown only when the tenant has set no name of its own. */
const BRAND_FALLBACK = deploymentBrand().productName;

/** Light/dark switch. Flips instantly and persists to the `theme` cookie so the
 *  next server render matches (no flash). */
function ThemeToggle({
  theme,
  onToggle,
  className,
}: {
  theme: Theme;
  onToggle: () => void;
  className?: string;
}) {
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={cn(
        'inline-flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm text-muted transition hover:bg-[var(--surface)] hover:text-cream',
        className,
      )}
    >
      <Icon name={theme === 'light' ? 'moon' : 'sun'} className="h-4 w-4" />
      <span className="lg:inline">{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
    </button>
  );
}

function isActive(pathname: string, href: string) {
  if (href === `/${href.split('/')[1]}` && pathname === href) return true;
  // exact for section roots, prefix for children
  const segments = href.split('/').filter(Boolean);
  if (segments.length === 1) return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

export function AppShell({
  role,
  roleLabel,
  items,
  name,
  email,
  brandName,
  logoUrl,
  initialTheme = 'dark',
  children,
}: {
  role: UserRole;
  roleLabel: string;
  items: NavItem[];
  name: string | null;
  email: string | null;
  brandName?: string;
  logoUrl?: string;
  initialTheme?: Theme;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const primary = items.filter((i) => i.primary).slice(0, 5);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  function toggleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    // Persist for the next server render (1 year). Not sensitive.
    document.cookie = `theme=${next};path=/;max-age=31536000;samesite=lax`;
  }

  return (
    <div data-theme={theme} className="app-shell min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      {/* Lets keyboard and screen-reader users jump past the ~12 repeated nav links on
          every page (WCAG 2.4.1 Bypass Blocks, Level A). Visible only on focus. */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-hair-soft bg-navy/60 p-5 backdrop-blur lg:flex">
        <Link href={`/${role}`} className="mb-8 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {logoUrl ? (
            <img src={logoUrl} alt="" style={{ maxHeight: 28 }} className="w-auto" />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src="/icon.svg" alt="" className="h-10 w-10" />
          )}
          <div>
            <p className="font-display text-lg leading-none text-cream">{brandName ?? BRAND_FALLBACK}</p>
            <p className="eyebrow mt-1">{roleLabel}</p>
          </div>
        </Link>

        <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex items-center gap-3 rounded-[var(--radius)] px-3 py-2.5 text-sm transition',
                  active
                    ? 'bg-[rgba(184,151,42,0.12)] text-cream'
                    : 'text-muted hover:bg-[var(--surface)] hover:text-cream',
                )}
              >
                <span className={cn(active ? 'text-gold-bright' : 'text-muted group-hover:text-gold')}>
                  <Icon name={item.icon} />
                </span>
                {item.label}
                {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-gold-bright" />}
              </Link>
            );
          })}
        </nav>

        <div className="mt-4 border-t border-hair-soft pt-4">
          <p className="truncate text-sm text-cream">{name ?? 'Account'}</p>
          <p className="truncate text-xs text-muted">{email}</p>
          <ThemeToggle theme={theme} onToggle={toggleTheme} className="mt-3 w-full" />
          <form action="/auth/signout" method="post" className="mt-1">
            <button className="flex w-full items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm text-muted transition hover:bg-[var(--surface)] hover:text-cream">
              <Icon name="logout" className="h-4 w-4" /> Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-dvh flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-hair-soft bg-ink/85 px-4 py-3 backdrop-blur lg:hidden">
          <Link href={`/${role}`} className="flex items-center gap-2">
            {logoUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={logoUrl} alt="" style={{ maxHeight: 28 }} className="w-auto" />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src="/icon.svg" alt="" className="h-8 w-8" />
            )}
            <span className="font-display text-base text-cream">{brandName ?? BRAND_FALLBACK}</span>
          </Link>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              className="p-1 text-muted hover:text-cream"
            >
              <Icon name={theme === 'light' ? 'moon' : 'sun'} />
            </button>
            <form action="/auth/signout" method="post">
              <button className="p-1 text-muted hover:text-cream" aria-label="Sign out">
                <Icon name="logout" />
              </button>
            </form>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-6 pb-28 sm:px-6 lg:px-10 lg:py-10 lg:pb-12">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>

        {/* Mobile bottom nav */}
        <nav
          aria-label="Primary shortcuts"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-hair-soft bg-ink/95 backdrop-blur lg:hidden"
        >
          <div className="mx-auto grid max-w-2xl" style={{ gridTemplateColumns: `repeat(${primary.length}, 1fr)` }}>
            {primary.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-1 py-2.5 text-[0.625rem] font-medium transition',
                    active ? 'text-gold-bright' : 'text-muted',
                  )}
                >
                  <span className={cn('relative', active && "after:absolute after:-top-2.5 after:left-1/2 after:h-0.5 after:w-6 after:-translate-x-1/2 after:rounded-full after:bg-gold-bright")}>
                    <Icon name={item.icon} />
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
