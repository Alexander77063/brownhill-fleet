import type { Metadata } from 'next';
import { LegalShell } from '@/components/legal/LegalShell';
import { OPERATOR } from '@/lib/legal';

export const metadata: Metadata = { title: 'Acceptable Use Policy' };

export default function AcceptableUsePage() {
  return (
    <LegalShell title="Acceptable Use Policy">
      <p>
        This Acceptable Use Policy (<strong>&ldquo;AUP&rdquo;</strong>) sets out what you may not do with the{' '}
        {OPERATOR.product} platform (the <strong>&ldquo;Service&rdquo;</strong>). It forms part of the{' '}
        <a href="/terms">Terms of Service</a>. Breaching it may lead to suspension or termination.
      </p>

      <h2>1. Prohibited conduct</h2>
      <p>You must not, and must not permit anyone to:</p>
      <ul>
        <li>use the Service for any unlawful, fraudulent, deceptive or harmful purpose, or in breach of any law or regulation (including road-transport, licensing, consumer, data-protection or financial rules);</li>
        <li>infringe the intellectual property, privacy, or other rights of any person — including uploading logos, images, text or documents you do not have the right to use;</li>
        <li>upload malware, or attempt to gain unauthorised access to, probe, scan, disrupt, overload, or circumvent the security or tenant isolation of the Service or others&rsquo; data;</li>
        <li>scrape, harvest, or bulk-extract data other than your own, or reverse-engineer the Service except as permitted by law;</li>
        <li>send unsolicited or unlawful communications (spam) to drivers, customers or others via the Service&rsquo;s email/SMS features, or in breach of PECR/marketing rules;</li>
        <li>process special-category or other personal data without a lawful basis, or use the Service to track or immobilise a vehicle without a lawful basis and appropriate notice to affected individuals;</li>
        <li>resell, sublicense, or provide the Service to third parties except as expressly permitted by your plan;</li>
        <li>misrepresent your identity or your authority to bind your organisation.</li>
      </ul>

      <h2>2. Copyright &amp; intellectual-property infringement</h2>
      <p>
        We respect intellectual-property rights and expect you to do the same. Content you upload (including brand
        assets, contracts and documents) must be yours or properly licensed. If you believe content on the Service
        infringes your copyright or other rights, send a notice to {OPERATOR.contactEmail} including: your contact
        details; identification of the work and the allegedly infringing material (with a URL or description);
        confirmation you have a good-faith belief the use is unauthorised; and a statement that the information is
        accurate. We will review valid notices, may remove or disable the material, and may suspend repeat infringers.
        Where appropriate we will pass a notice to the responsible Subscriber, who may respond.
      </p>

      <h2>3. Your data &amp; privacy responsibilities</h2>
      <p>
        You are responsible for having a lawful basis to collect and process the personal data you put into the
        Service (drivers, staff, customers), for giving those individuals the required privacy information, and for
        honouring their rights. Vehicle tracking and immobilisation features must only be used lawfully, proportionately,
        and with appropriate notice — never to harass, endanger, or unlawfully surveil a person.
      </p>

      <h2>4. Enforcement</h2>
      <p>
        We may investigate suspected breaches and may remove content, or suspend or terminate access, to protect the
        Service, other users, or third parties, or to comply with law — with or without notice depending on severity.
      </p>

      <h2>5. Reporting</h2>
      <p>
        Report abuse, security issues, or infringement to {OPERATOR.contactEmail}. {OPERATOR.entity} may update this
        AUP from time to time.
      </p>
    </LegalShell>
  );
}
