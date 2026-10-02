import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL_DOCS, OPERATOR } from '@/lib/legal';
import { deploymentBrand } from '@/lib/deployment/brand';

export const metadata: Metadata = {
  title: 'Accessibility',
  description:
    `Accessibility statement for ${deploymentBrand().productName} — our WCAG 2.1 AA position, known limitations, and how to report a barrier.`,
};

/**
 * Public accessibility statement.
 *
 * Deliberately NOT part of LEGAL_DOCS: those documents are the versioned set a tenant must
 * accept, and publishing a statement is not something a user agrees to. It also does not
 * use LegalShell, whose "draft template, get it reviewed" banner would misrepresent this
 * page — the contents here are statements of fact about the product, not a legal template.
 *
 * Keep in step with docs/accessibility/VPAT.md. Do not upgrade the wording to a full
 * conformance claim until the runtime and assistive-technology passes have been completed.
 */
const STATEMENT_UPDATED = '31 July 2026';

export default function AccessibilityPage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
      <Link href="/" className="text-sm text-gold-bright hover:underline">
        ← {deploymentBrand().productName}
      </Link>

      <h1 className="mt-4 font-display text-3xl text-cream sm:text-4xl">Accessibility</h1>
      <p className="mt-2 text-sm text-muted">
        Last updated {STATEMENT_UPDATED} · Operated by {OPERATOR.entity} (registered in {OPERATOR.jurisdiction})
      </p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-parchment">
        <section>
          <h2 className="font-display text-xl text-cream">Our commitment</h2>
          <p className="mt-2">
            We want every fleet operator, driver and administrator to be able to use Elite Fleet
            Management, including people who rely on screen readers, keyboard-only navigation,
            magnification or high-contrast display settings. We work to the{' '}
            <a
              href="https://www.w3.org/TR/WCAG21/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold-bright hover:underline"
            >
              Web Content Accessibility Guidelines 2.1, Level AA
            </a>
            , which is also the technical basis of EN 301 549 and the European Accessibility Act.
          </p>
        </section>

        <section>
          <h2 className="font-display text-xl text-cream">Current status</h2>
          <p className="mt-2">
            {deploymentBrand().productName} is <strong className="text-cream">partially conformant</strong>{' '}
            with WCAG 2.1 Level AA. &ldquo;Partially conformant&rdquo; means most of the standard is
            met, but some parts are not yet met or have not yet been fully tested.
          </p>
          <p className="mt-2">
            We completed a full accessibility review on {STATEMENT_UPDATED}, covering both the
            source code and the running application (36 pages tested in a real browser with
            automated WCAG tooling). It remediated colour contrast across the light theme, added
            a skip link and proper table semantics throughout, gave every form control an
            accessible name, introduced announced status messages, fixed pages that scrolled
            sideways on a narrow phone, and — most importantly — added a keyboard-accessible way
            to sign a rental agreement, which previously required drawing with a pointer.
          </p>
        </section>

        <section>
          <h2 className="font-display text-xl text-cream">Known limitations</h2>
          <p className="mt-2">We are honest about what is not yet done:</p>
          <ul className="mt-2 ml-5 list-disc space-y-1">
            <li>
              Live vehicle maps are drawn on a canvas, which a screen reader cannot interpret.
              Wherever a map appears we also show the same position as text — as a table of
              vehicle positions, or as coordinates with a link to an external map.
            </li>
            <li>
              We have not yet completed testing with screen readers (NVDA, JAWS, VoiceOver).
              Automated testing can confirm that a control has a name; only a person using a
              screen reader can confirm the name is genuinely useful.
            </li>
            <li>We have not yet verified the platform at 200% browser zoom.</li>
            <li>
              Some confirmation messages on operations screens are shown after a page refresh
              rather than announced immediately.
            </li>
            <li>Wide financial tables scroll sideways; they can be scrolled with the keyboard.</li>
          </ul>
          <p className="mt-2">
            These are scheduled for the next accessibility iteration, which will add automated
            browser-based testing and a manual assistive-technology review.
          </p>
        </section>

        <section>
          <h2 className="font-display text-xl text-cream">Reporting a barrier</h2>
          <p className="mt-2">
            If something on this platform prevents you from completing a task, please tell us — it
            is treated as a defect, not a feature request. Email{' '}
            <a href={`mailto:${OPERATOR.contactEmail}`} className="text-gold-bright hover:underline">
              {OPERATOR.contactEmail}
            </a>{' '}
            with the page, what you were trying to do, and the assistive technology you use if
            relevant. We aim to acknowledge within 5 working days.
          </p>
          <p className="mt-2">
            If you are a driver and cannot complete a signing or payment step, contact your fleet
            operator as well so they can complete it with you in the meantime. No one should lose
            access to a vehicle or be charged because a page was not usable.
          </p>
        </section>

        <section>
          <h2 className="font-display text-xl text-cream">Enforcement</h2>
          <p className="mt-2">
            In the United Kingdom, the Equality Act 2010 requires service providers to make
            reasonable adjustments for disabled people. If you are not satisfied with how we
            respond, you can contact the{' '}
            <a
              href="https://www.equalityadvisoryservice.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold-bright hover:underline"
            >
              Equality Advisory and Support Service
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="font-display text-xl text-cream">For procurement teams</h2>
          <p className="mt-2">
            A detailed Accessibility Conformance Report (VPAT-style, criterion by criterion,
            including what has not been evaluated) is available on request from{' '}
            <a href={`mailto:${OPERATOR.contactEmail}`} className="text-gold-bright hover:underline">
              {OPERATOR.contactEmail}
            </a>
            .
          </p>
        </section>
      </div>

      <nav aria-label="Legal documents" className="mt-12 flex flex-wrap gap-4 border-t border-hair-soft pt-6 text-sm">
        {LEGAL_DOCS.map((d) => (
          <Link key={d.slug} href={`/${d.slug}`} className="text-muted transition hover:text-cream">
            {d.title}
          </Link>
        ))}
        <span className="ml-auto text-muted">© {OPERATOR.entity}</span>
      </nav>
    </main>
  );
}
