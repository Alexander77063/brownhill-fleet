import type { Metadata } from 'next';
import { LegalShell } from '@/components/legal/LegalShell';
import { OPERATOR } from '@/lib/legal';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service">
      <p>
        These Terms of Service (the <strong>&ldquo;Terms&rdquo;</strong>) govern your access to and use of the{' '}
        {OPERATOR.product} platform (the <strong>&ldquo;Service&rdquo;</strong>), operated by {OPERATOR.entity}, a
        company registered in {OPERATOR.jurisdiction} (company number {OPERATOR.companyNumber}), registered office{' '}
        {OPERATOR.registeredAddress} (<strong>&ldquo;we&rdquo;</strong>, <strong>&ldquo;us&rdquo;</strong>). By creating
        an account, accepting these Terms, or using the Service, the organisation you represent (the{' '}
        <strong>&ldquo;Subscriber&rdquo;</strong>, <strong>&ldquo;you&rdquo;</strong>) agrees to these Terms.
      </p>

      <h2>1. The Service</h2>
      <p>
        The Service is a multi-tenant, white-label operating system for private-hire and vehicle-rental operators,
        covering vehicles, hire agreements, drivers, compliance, charges, payments and related tools. We grant you a
        non-exclusive, non-transferable, revocable licence to use the Service for your internal business purposes for
        the duration of your subscription, subject to these Terms and your plan.
      </p>

      <h2>2. Accounts &amp; eligibility</h2>
      <p>
        You must be a business acting in the course of trade, be at least 18, and provide accurate registration
        details. You are responsible for your account, your users (operators, staff and drivers you invite), and all
        activity under them, and for keeping credentials secure. You must notify us promptly of any unauthorised use.
      </p>

      <h2>3. Subscriptions, plans &amp; fees</h2>
      <ul>
        <li>The Service is offered on tiered plans (including a free trial). Features and limits depend on your plan.</li>
        <li>
          Paid subscriptions are billed in advance on a recurring basis through our payment processor (Stripe). By
          subscribing you authorise recurring charges until you cancel.
        </li>
        <li>Fees are exclusive of VAT and taxes unless stated, which you are responsible for.</li>
        <li>
          Except where required by law, fees are non-refundable. You may cancel at any time; cancellation takes effect
          at the end of the current billing period.
        </li>
        <li>We may change prices on reasonable notice; changes apply from your next renewal.</li>
      </ul>

      <h2>4. Your data &amp; responsibilities</h2>
      <p>
        You retain ownership of the data you and your users submit (<strong>&ldquo;Subscriber Data&rdquo;</strong>),
        including personal data of your drivers and customers. As between us, you are the data controller of Subscriber
        Data and we are your processor; our processing is governed by our{' '}
        <a href="/privacy">Privacy Policy</a> and Data Processing terms. You are responsible for having a lawful basis
        to collect and process that data, for the accuracy of the data, and for your own compliance (including licensing,
        insurance, DVLA/PCO, VAT, and consumer/hire law obligations). We are not a party to, and give no advice on, your
        agreements with your drivers, customers, funders or authorities.
      </p>

      <h2>5. Acceptable use</h2>
      <p>
        Your use of the Service is subject to our <a href="/acceptable-use">Acceptable Use Policy</a>, which is
        incorporated into these Terms. We may suspend or limit access to investigate or address a breach, a security or
        legal risk, or non-payment.
      </p>

      <h2>6. Third-party services</h2>
      <p>
        The Service integrates optional third-party services you choose to connect or that power features — for example
        Stripe and GoCardless (payments), DVLA and Companies House (lookups), getAddress (addresses), email/SMS
        providers, mapping, and AI providers. Your use of those services is subject to their own terms, and we are not
        responsible for them. Where you bring your own provider keys, you are responsible for those accounts and their
        charges.
      </p>

      <h2>7. Intellectual property</h2>
      <p>
        We and our licensors own all rights in the Service, its software, and its look and feel. White-label branding
        you apply remains yours. You must not copy, reverse-engineer, resell, or create derivative works of the Service
        except as permitted by law or these Terms. You grant us a licence to host and process Subscriber Data solely to
        provide and support the Service.
      </p>

      <h2>8. Warranties &amp; disclaimers</h2>
      <p>
        We provide the Service with reasonable skill and care. Otherwise, to the fullest extent permitted by law, the
        Service is provided <strong>&ldquo;as is&rdquo;</strong> and we disclaim all other warranties (including fitness
        for a particular purpose and uninterrupted or error-free operation). Lookups, telematics, financial figures and
        AI-generated output are provided for convenience and may be incomplete or inaccurate — you must verify them
        before relying on them for decisions, contracts, or filings.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        Nothing limits liability for death or personal injury caused by negligence, fraud, or anything that cannot be
        limited by law. Subject to that: we are not liable for loss of profit, revenue, data, goodwill, or indirect or
        consequential loss; and our total aggregate liability arising out of or in connection with the Service in any
        12-month period is limited to the fees you paid us in that period.
      </p>

      <h2>10. Indemnity</h2>
      <p>
        You will indemnify us against claims, losses and costs arising from your Subscriber Data, your use of the
        Service in breach of these Terms or the Acceptable Use Policy, or your breach of law or third-party rights.
      </p>

      <h2>11. Term, suspension &amp; termination</h2>
      <p>
        These Terms apply while you use the Service. Either party may terminate a subscription at the end of a billing
        period; we may suspend or terminate immediately for material breach, non-payment, or legal/security risk. On
        termination your right to use the Service ends. You may export your data before termination; we may delete
        Subscriber Data after a reasonable period in line with our Privacy Policy.
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update the Service and these Terms. Where changes are material we will give reasonable notice (for
        example in-app or by email) and, where required, ask you to re-accept. Continued use after changes take effect
        constitutes acceptance.
      </p>

      <h2>13. Governing law &amp; disputes</h2>
      <p>
        These Terms and any dispute arising from them are governed by the laws of {OPERATOR.jurisdiction}, and the
        courts of {OPERATOR.jurisdiction} have exclusive jurisdiction. Nothing affects mandatory rights you may have.
      </p>

      <h2>14. General</h2>
      <p>
        You may not assign these Terms without our consent; we may assign to a group company or on a sale of the
        business. If any provision is unenforceable, the rest remain in force. These Terms, the Acceptable Use Policy
        and the Privacy Policy are the entire agreement between us on their subject matter. Notices to us may be sent to{' '}
        {OPERATOR.contactEmail}.
      </p>

      <h2>15. Contact</h2>
      <p>
        {OPERATOR.entity} · {OPERATOR.contactEmail} · {OPERATOR.website}
      </p>
    </LegalShell>
  );
}
