import type { Metadata } from 'next';
import { LegalShell } from '@/components/legal/LegalShell';
import { OPERATOR } from '@/lib/legal';

export const metadata: Metadata = { title: 'Data Processing Addendum' };

export default function DpaPage() {
  return (
    <LegalShell title="Data Processing Addendum">
      <p>
        This Data Processing Addendum (<strong>&ldquo;DPA&rdquo;</strong>) forms part of the{' '}
        <a href="/terms">Terms of Service</a> between {OPERATOR.entity} (<strong>&ldquo;Processor&rdquo;</strong>,{' '}
        <strong>&ldquo;we&rdquo;</strong>) and the Subscriber (<strong>&ldquo;Controller&rdquo;</strong>,{' '}
        <strong>&ldquo;you&rdquo;</strong>) and applies where we process Personal Data on your behalf through the{' '}
        {OPERATOR.product} platform (the <strong>&ldquo;Service&rdquo;</strong>). It reflects the requirements of Article
        28 of the UK GDPR. If it conflicts with the Terms on data protection, this DPA prevails.
      </p>

      <h2>1. Definitions</h2>
      <p>
        &ldquo;UK GDPR&rdquo;, &ldquo;Personal Data&rdquo;, &ldquo;Processing&rdquo;, &ldquo;Controller&rdquo;,
        &ldquo;Processor&rdquo;, &ldquo;Data Subject&rdquo; and &ldquo;Personal Data Breach&rdquo; have the meanings in
        UK data protection law (the UK GDPR and Data Protection Act 2018). &ldquo;Subscriber Personal Data&rdquo; means
        Personal Data we process on your behalf under the Terms.
      </p>

      <h2>2. Roles &amp; scope</h2>
      <p>
        As between the parties, you are the Controller and we are the Processor of Subscriber Personal Data. Each party
        will comply with its obligations under UK data protection law. The subject matter, duration, nature, purpose,
        types of data and categories of Data Subjects are set out in <strong>Annex A</strong>.
      </p>

      <h2>3. Processing on your instructions</h2>
      <p>
        We will process Subscriber Personal Data only on your documented instructions (including as set out in the Terms
        and your configuration and use of the Service), unless required by law — in which case we will, where permitted,
        inform you first. We will promptly tell you if, in our opinion, an instruction infringes data protection law.
      </p>

      <h2>4. Confidentiality</h2>
      <p>
        We ensure that persons authorised to process Subscriber Personal Data are bound by appropriate confidentiality
        obligations and only access data on a need-to-know basis.
      </p>

      <h2>5. Security</h2>
      <p>
        Taking account of the state of the art, costs, and the nature, scope, context and risk of the processing, we
        implement appropriate technical and organisational measures to ensure a level of security appropriate to the
        risk, as described in <strong>Annex B</strong>.
      </p>

      <h2>6. Sub-processors</h2>
      <p>
        You give general authorisation for us to engage sub-processors to provide the Service. Our current
        sub-processors are listed in <strong>Annex C</strong>. We impose data protection obligations on each
        sub-processor no less protective than those in this DPA, and we remain responsible for their performance. We
        will give you reasonable notice of any intended change of sub-processor and a chance to object on reasonable
        data-protection grounds; if we cannot resolve a reasonable objection, you may terminate the affected part of the
        Service.
      </p>

      <h2>7. Assisting you</h2>
      <ul>
        <li>
          <strong>Data-subject rights:</strong> taking account of the nature of the processing, we provide reasonable
          assistance (including appropriate technical and organisational measures) to help you respond to Data-Subject
          requests. Where a Data Subject contacts us directly about your data, we will refer them to you.
        </li>
        <li>
          <strong>DPIAs &amp; consultation:</strong> we provide reasonable assistance with data protection impact
          assessments and prior consultation with the ICO, given the information available to us.
        </li>
      </ul>

      <h2>8. Personal Data Breach</h2>
      <p>
        We will notify you without undue delay after becoming aware of a Personal Data Breach affecting Subscriber
        Personal Data, and provide information reasonably available to us to help you meet your own notification
        obligations.
      </p>

      <h2>9. International transfers</h2>
      <p>
        We will not transfer Subscriber Personal Data outside the UK/EEA except where an appropriate safeguard is in
        place (such as UK adequacy regulations, the International Data Transfer Agreement, or the UK Addendum to the EU
        Standard Contractual Clauses), or another lawful basis applies.
      </p>

      <h2>10. Return &amp; deletion</h2>
      <p>
        On termination of the Service, and at your choice, we will delete or return Subscriber Personal Data and delete
        existing copies, unless we are required by law to retain it. You may export your data before termination using
        the Service.
      </p>

      <h2>11. Audits</h2>
      <p>
        We make available information reasonably necessary to demonstrate compliance with this DPA and allow for and
        contribute to audits, including inspections, conducted by you or an auditor you mandate — on reasonable prior
        notice, no more than once a year (unless required by a regulator or following a Breach), during business hours,
        subject to confidentiality, and without unreasonably disrupting our operations.
      </p>

      <h2>12. Liability</h2>
      <p>Each party&rsquo;s liability under this DPA is subject to the limitations and exclusions in the Terms.</p>

      <h2>13. Term</h2>
      <p>This DPA applies for as long as we process Subscriber Personal Data under the Terms.</p>

      <h2>Annex A — Details of processing</h2>
      <ul>
        <li><strong>Subject matter:</strong> provision of the {OPERATOR.product} platform to the Controller.</li>
        <li><strong>Duration:</strong> the term of the subscription, plus any retention period in the Terms/Privacy Policy.</li>
        <li><strong>Nature &amp; purpose:</strong> hosting, storage, and processing of records to operate a vehicle-rental / private-hire business — vehicles, agreements, drivers, compliance, charges, payments, communications, and (where enabled) telematics and AI-assisted analysis.</li>
        <li><strong>Types of Personal Data:</strong> identification and contact details; driver licence, PCO and DVLA-related details; insurance details; addresses; vehicle and agreement records; payment and arrears data; message logs; and, where enabled by the Controller, vehicle location/telematics.</li>
        <li><strong>Categories of Data Subjects:</strong> the Controller&rsquo;s staff/operators, drivers, and customers.</li>
      </ul>

      <h2>Annex B — Technical &amp; organisational measures</h2>
      <ul>
        <li>Encryption of data in transit (TLS) and encryption of sensitive credentials at rest.</li>
        <li>Per-tenant data isolation enforced at the database (row-level security).</li>
        <li>Role-based access control and least-privilege access for staff.</li>
        <li>Authentication via a managed identity provider; secrets held in a secure configuration store.</li>
        <li>Immutable audit logging of security-relevant actions.</li>
        <li>Reputable infrastructure sub-processors with their own security certifications.</li>
        <li>Backup and recovery processes, and monitoring to detect and respond to incidents.</li>
      </ul>

      <h2>Annex C — Sub-processors</h2>
      <ul>
        <li><strong>Supabase</strong> — database, authentication.</li>
        <li><strong>Vercel</strong> — application hosting.</li>
        <li><strong>Cloudflare (R2)</strong> — file/object storage.</li>
        <li><strong>Stripe</strong> — subscription and payment processing.</li>
        <li><strong>GoCardless</strong> — direct-debit payment processing (where used).</li>
        <li><strong>Resend</strong> — transactional email.</li>
        <li><strong>Twilio</strong> — SMS (where used).</li>
        <li><strong>AI provider</strong> — the model provider powering the included assistant.</li>
      </ul>
      <p className="mt-2 text-xs text-muted">
        Note for {OPERATOR.entity}: keep this sub-processor list accurate and confirm each provider&rsquo;s transfer
        safeguards with your solicitor/DPO before launch.
      </p>

      <h2>Contact</h2>
      <p>{OPERATOR.entity} · {OPERATOR.privacyEmail}</p>
    </LegalShell>
  );
}
