import type { Metadata } from 'next';
import { LegalShell } from '@/components/legal/LegalShell';
import { OPERATOR } from '@/lib/legal';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy">
      <p>
        This Privacy Policy explains how {OPERATOR.entity} (<strong>&ldquo;we&rdquo;</strong>) handles personal data in
        connection with the {OPERATOR.product} platform (the <strong>&ldquo;Service&rdquo;</strong>). We comply with the
        UK GDPR and the Data Protection Act 2018.
      </p>

      <h2>1. Our two roles</h2>
      <ul>
        <li>
          <strong>Controller</strong> — for the account and platform data of our Subscribers and their users (e.g.
          contact details, billing, and how the Service is used).
        </li>
        <li>
          <strong>Processor</strong> — for the data a Subscriber puts into the Service about their own drivers, staff
          and customers (<strong>&ldquo;Subscriber Data&rdquo;</strong>). The Subscriber is the controller of that data;
          we process it only on their instructions to provide the Service. Our processing terms form part of the{' '}
          <a href="/terms">Terms of Service</a>.
        </li>
      </ul>

      <h2>2. Data we collect</h2>
      <ul>
        <li><strong>Account &amp; billing:</strong> name, business, email, phone, plan, and payment status (card data is handled by Stripe, not stored by us).</li>
        <li><strong>Usage &amp; device:</strong> log data, IP address, actions taken, and cookies necessary to run the Service.</li>
        <li><strong>Subscriber Data (as processor):</strong> may include drivers&rsquo; and customers&rsquo; names, contact details, addresses, licence/PCO details, insurance, vehicle and agreement records, charges, payments, and — where the Subscriber enables it — vehicle GPS/telematics.</li>
      </ul>

      <h2>3. How we use data &amp; lawful bases</h2>
      <p>
        As controller we use account/usage data to provide, secure, support, bill and improve the Service — on the
        bases of <strong>contract</strong> (to deliver what you subscribed to), <strong>legitimate interests</strong>
        (running and securing our business), and <strong>legal obligation</strong> (e.g. tax). As processor, we use
        Subscriber Data only to provide the Service on the Subscriber&rsquo;s instructions.
      </p>

      <h2>4. Sharing &amp; sub-processors</h2>
      <p>
        We do not sell personal data. We share it with service providers who process it on our behalf under contract,
        including: Supabase (database/auth), Vercel (hosting), Cloudflare R2 (file storage), Stripe and GoCardless
        (payments), Resend (email), Twilio (SMS), and AI providers we use to power the assistant. Feature lookups (DVLA,
        Companies House, getAddress) are used as directed. We may also disclose data where required by law or to protect
        rights and safety. Subscribers remain responsible for third-party providers they connect with their own keys.
      </p>

      <h2>5. International transfers</h2>
      <p>
        Some providers may process data outside the UK/EEA. Where they do, we rely on appropriate safeguards (such as UK
        adequacy regulations or the International Data Transfer Agreement/SCCs).
      </p>

      <h2>6. Retention</h2>
      <p>
        We keep account data for as long as your subscription is active and for a reasonable period afterwards to meet
        legal, tax and dispute needs, then delete or anonymise it. Subscriber Data is retained per the Subscriber&rsquo;s
        instructions and deleted after termination in line with the Terms. Immutable audit logs are kept for security and
        accountability.
      </p>

      <h2>7. Security</h2>
      <p>
        We use encryption in transit, access controls, per-tenant isolation at the database, encryption of sensitive
        credentials at rest, and audit logging. No system is perfectly secure; we maintain processes to detect and
        respond to incidents and will notify affected parties and regulators where the law requires.
      </p>

      <h2>8. Your rights</h2>
      <p>
        Subject to conditions, you have rights to access, rectify, erase, restrict, port and object to processing of
        your personal data, and to withdraw consent. If your data was entered into the Service by a Subscriber (e.g.
        you are a driver), please contact that Subscriber (the controller) first; we will assist them. To exercise
        rights against us as controller, contact {OPERATOR.privacyEmail}.
      </p>

      <h2>9. Cookies</h2>
      <p>
        We use strictly-necessary cookies to authenticate sessions and run the Service. We do not use advertising
        cookies. Your browser can block cookies, but the Service may not function without the necessary ones.
      </p>

      <h2>10. Children</h2>
      <p>The Service is for businesses and is not directed to children.</p>

      <h2>11. Changes</h2>
      <p>We may update this policy; material changes will be notified and, where required, re-accepted.</p>

      <h2>12. Contact &amp; complaints</h2>
      <p>
        {OPERATOR.entity} · {OPERATOR.privacyEmail}. You have the right to complain to the UK Information
        Commissioner&rsquo;s Office (ico.org.uk), though we ask that you contact us first.
      </p>
    </LegalShell>
  );
}
