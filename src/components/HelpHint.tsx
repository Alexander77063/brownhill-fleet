'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/icons';
import { HELP, type HelpKey } from '@/lib/help-content';

const POP_WIDTH = 288; // matches w-72

/**
 * An accessible ⓘ help affordance. Reveals a short "what is this / how to set it
 * up" popover on hover, keyboard focus, or click (click pins it open; Escape or an
 * outside click closes a pinned popover). Content comes from the `help-content`
 * registry so copy lives in one place.
 *
 * The popover is rendered in a portal on document.body with a fixed position, so it
 * always sits above page content regardless of ancestor stacking contexts or
 * `overflow` (a plain absolutely-positioned popover was painting BEHIND later page
 * sections). It carries the nearest data-theme so it stays correct in light mode.
 */
export function HelpHint({ id, label }: { id: HelpKey; label?: string }) {
  const [pinned, setPinned] = useState(false);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [theme, setTheme] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - POP_WIDTH - 8);
    setCoords({ top: r.bottom + 8, left });
    setTheme(el.closest('[data-theme]')?.getAttribute('data-theme') ?? null);
  }

  function show() {
    place();
    setOpen(true);
  }
  function hide() {
    if (!pinned) setOpen(false);
  }

  // Close a pinned popover on outside click / Escape; reposition on scroll/resize.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    }
    function onMove() {
      place();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const entry = HELP[id];
  if (!entry) return null;

  const popover =
    open && coords && typeof document !== 'undefined'
      ? createPortal(
          <span
            {...(theme ? { 'data-theme': theme } : {})}
            id={popId}
            role="tooltip"
            style={{ position: 'fixed', top: coords.top, left: coords.left, width: POP_WIDTH, zIndex: 9999 }}
            className="card-surface block rounded-[var(--radius)] border border-hair-soft p-3.5 text-left shadow-[0_14px_40px_rgba(0,0,0,0.5)]"
          >
            <span className="eyebrow block text-parchment">{entry.title}</span>
            <span className="mt-1.5 block text-xs leading-relaxed text-parchment">{entry.body}</span>
            {entry.steps && (
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-muted">
                {entry.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
            {entry.docHref && (
              <a
                href={entry.docHref}
                className="mt-2 inline-block text-[11px] font-semibold text-gold-bright hover:underline"
              >
                Learn more →
              </a>
            )}
          </span>,
          document.body,
        )
      : null;

  return (
    <span ref={wrapRef} className="relative inline-flex align-middle">
      <button
        ref={btnRef}
        type="button"
        aria-label={label ? `Help: ${label}` : `About ${entry.title}`}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          const nextPinned = !pinned;
          setPinned(nextPinned);
          if (nextPinned) show();
          else setOpen(false);
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-gold transition hover:text-gold-bright focus-visible:text-gold-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-gold-bright)]"
      >
        <Icon name="info" className="h-4 w-4" />
      </button>
      {popover}
    </span>
  );
}
