'use client';

// src/components/ui/Dialog.tsx
// The modal dialog.
//
// WHY THIS EXISTS
// ---------------
// The repository had no dialog at all, and the first thing that needed one
// was the period close — an action that shuts a month and cannot be undone
// without a reopen window. A confirmation that a screen-reader user cannot
// operate is not a confirmation, so the dialog has to carry the whole
// keyboard contract, not just a visual box.
//
// THE CONTRACT
// ------------
//   * `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing at
//     the title, so assistive technology announces what the box is and what
//     it is called (WCAG 4.1.2 Name, Role, Value).
//   * Focus moves into the dialog when it opens, and back to whatever had it
//     when the dialog closes. Without the restore, an operator who cancels
//     is dropped at the top of the page and has to find their way back —
//     and keyboard focus falling back to the document body is the classic
//     symptom (WCAG 2.4.3 Focus Order).
//   * Tab and Shift+Tab cycle inside the dialog. The page behind is still
//     there and still focusable, and a keyboard user who tabs out of a
//     modal has no idea where they are (WCAG 2.1.2 No Keyboard Trap — the
//     trap here is the point, but it has to be a LOOP, not a dead end).
//   * Escape closes it. A dialog that cannot be dismissed with the keyboard
//     is a keyboard trap (WCAG 2.1.1 Keyboard, Level A).
//   * The page behind does not scroll while the dialog is open.
//
// IT IS ITS OWN FILE
// ------------------
// `src/components/ui/index.tsx` is imported by server components all over
// the app, and it has no `'use client'` — adding one would turn every
// component in it (PageHeader, Card, Table, Button…) into a client
// component and ship them all to the browser. This file is a client module
// on its own, re-exported from the index so it is imported the same way as
// everything else.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Everything that can hold focus, in the order the browser will walk it. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface DialogProps {
  /** Whether the dialog is on screen. */
  open: boolean;
  /** Called when the operator dismisses it — Escape, the backdrop, Cancel. */
  onClose: () => void;
  /** The dialog's title. Also its accessible name. */
  title: string;
  /** Optional context under the title. */
  description?: ReactNode;
  /** The body. */
  children?: ReactNode;
  /** The actions along the bottom. */
  footer?: ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Move focus in when it opens; move it back when it closes.
  //
  // The restore is what makes the dialog feel like a dialog rather than a
  // page change: the operator's place in the table is kept.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      const target = restoreFocusTo.current;
      restoreFocusTo.current = null;
      // The trigger may have been unmounted while the dialog was open (a
      // refresh after a successful action) — then there is nothing to
      // restore to, and focusing a detached node would throw.
      if (target && target.isConnected) target.focus();
    };
  }, [open]);

  // Escape closes; Tab stays inside.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // The page behind does not scroll while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      // The scrim is a pointer convenience, not a control: the dialog is
      // dismissible from the keyboard (Escape) and from the Cancel button,
      // and this div must not appear in the accessibility tree as an
      // interactive element with no name and no way to reach it.
      role="presentation"
      // A click on the scrim dismisses; a click that started inside the
      // panel and ended on the scrim does not, so a text selection that
      // ends outside the panel does not close it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'card-surface max-h-[90vh] w-full max-w-lg overflow-y-auto p-5 shadow-2xl',
          className,
        )}
      >
        <h2 id={titleId} className="text-lg text-cream">
          {title}
        </h2>
        {description && <div className="mt-1 text-sm text-muted">{description}</div>}
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
