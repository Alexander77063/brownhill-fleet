import Link from 'next/link';
import { LEGAL_DOCS, LEGAL_UPDATED, OPERATOR } from '@/lib/legal';
import { deploymentBrand } from '@/lib/deployment/brand';

/** Public wrapper for the legal documents — readable typography, the operator
 *  banner, a clear "draft, get it reviewed" notice, and cross-links. */
export function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
      <style>{`
        .legal h2{font-family:var(--font-display);font-size:1.15rem;color:var(--color-cream);margin:1.75rem 0 .5rem}
        .legal h3{font-weight:600;color:var(--color-cream);margin:1.25rem 0 .35rem}
        .legal p{margin:.5rem 0}
        .legal ul{margin:.5rem 0 .5rem 1.25rem;list-style:disc}
        .legal li{margin:.25rem 0}
        .legal strong{color:var(--color-cream)}
      `}</style>
      <Link href="/" className="text-sm text-gold-bright hover:underline">
        ← {deploymentBrand().productName}
      </Link>
      <h1 className="mt-4 font-display text-3xl text-cream sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        Last updated {LEGAL_UPDATED} · Operated by {OPERATOR.entity} (registered in {OPERATOR.jurisdiction})
      </p>
      <div
        className="mt-4 rounded-[var(--radius)] border border-[var(--color-warn)] px-4 py-3 text-xs text-parchment"
        style={{ background: 'rgba(217, 162, 59, 0.10)' }}
      >
        <strong className="text-[var(--color-warn)]">Draft template — not yet legal advice.</strong> This document is a
        starting point tailored to the platform and must be reviewed by a qualified solicitor before you rely on it.
      </div>
      <article className="legal mt-8 text-sm leading-relaxed text-parchment">{children}</article>
      <nav aria-label="Legal documents" className="mt-12 flex flex-wrap gap-4 border-t border-hair-soft pt-6 text-sm">
        {LEGAL_DOCS.map((d) => (
          <Link key={d.slug} href={`/${d.slug}`} className="text-muted transition hover:text-cream">
            {d.title}
          </Link>
        ))}
        {/* Not in LEGAL_DOCS — the accessibility statement is published, not accepted. */}
        <Link href="/accessibility" className="text-muted transition hover:text-cream">
          Accessibility
        </Link>
        <span className="ml-auto text-muted">© {OPERATOR.entity}</span>
      </nav>
    </main>
  );
}
