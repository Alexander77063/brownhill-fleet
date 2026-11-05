/** Single source of truth for the legal documents + the current version. Pure (no
 *  server imports) so it's usable in client and server components. Bump LEGAL_VERSION
 *  whenever ANY document changes — every tenant is then required to re-accept. */

export const LEGAL_VERSION = '2026-07-30';
export const LEGAL_UPDATED = '30 July 2026';

/**
 * Who operates the service, for the legal pages.
 *
 * EVERY FIELD IS OPTIONAL, and every one of them may legitimately be empty.
 *
 * That is the whole point of this shape. A legal page that prints a bracketed
 * placeholder — "a company registered in England and Wales (company number
 * [company registration number]), registered office [registered office
 * address]" — is a document nobody can enter into: it is a template that
 * escaped. It was exactly that, and the brackets shipped.
 *
 * A legal page that prints a real-looking address the operator does not own
 * is worse, because it is false and it is convincing. So the pages OMIT the
 * clause when the value is missing, and the values come from the install's own
 * configuration rather than from a constant in the source.
 */
export interface OperatorIdentity {
  /** The legal entity that operates the service. */
  entity: string;
  /** The product that entity operates. */
  product: string;
  /** The jurisdiction whose law governs. */
  jurisdiction: string;
  /** The company registration number. Empty when the operator has not set one. */
  companyNumber: string;
  /** The registered office address. Empty when the operator has not set one. */
  registeredAddress: string;
  /** Where general enquiries go. */
  contactEmail: string;
  /** Where privacy enquiries go. */
  privacyEmail: string;
  /** The operator's own website. */
  website: string;
}

/**
 * The PLATFORM's operator — the company that runs the multi-tenant service.
 *
 * Configured by environment, because the platform's identity is a property of
 * the installation and not of the code.
 *
 * Nothing here is hardcoded to any one company's name, address or contact
 * details. This repository is a fork, and a fork that published its upstream's
 * operator details as its own would be putting a stranger's name on its own
 * legal pages: the privacy policy of a box the customer operates would tell
 * them to write to a company that has nothing to do with them.
 *
 * Every field is empty unless the install sets it, and the pages omit the
 * clause rather than print a placeholder.
 */
export const PLATFORM_OPERATOR: OperatorIdentity = {
  entity: process.env.LEGAL_OPERATOR_ENTITY ?? '',
  product: process.env.LEGAL_OPERATOR_PRODUCT ?? '',
  jurisdiction: process.env.LEGAL_OPERATOR_JURISDICTION ?? '',
  companyNumber: process.env.LEGAL_OPERATOR_COMPANY_NUMBER ?? '',
  registeredAddress: process.env.LEGAL_OPERATOR_REGISTERED_ADDRESS ?? '',
  contactEmail: process.env.LEGAL_OPERATOR_CONTACT_EMAIL ?? '',
  privacyEmail: process.env.LEGAL_OPERATOR_PRIVACY_EMAIL ?? '',
  website: process.env.LEGAL_OPERATOR_WEBSITE ?? '',
};

export const LEGAL_DOCS = [
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'acceptable-use', title: 'Acceptable Use Policy' },
  { slug: 'dpa', title: 'Data Processing Addendum' },
] as const;

export type LegalSlug = (typeof LEGAL_DOCS)[number]['slug'];

/**
 * A sentence fragment, or nothing.
 *
 * The legal pages used to interpolate a value straight into a sentence, so an
 * unset value produced "a company registered in England and Wales (company
 * number ), registered office ". This joins only the parts that exist.
 */
export function clause(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(' ');
}

/**
 * How a reader reaches the operator.
 *
 * An address when the operator has published one, and a description when they
 * have not. Never an empty string inside a sentence, and never a placeholder:
 * "send a notice to  including:" is not a sentence anybody can act on.
 */
export function contactOf(
  operator: OperatorIdentity,
  kind: 'contact' | 'privacy' = 'contact',
): string {
  const email = kind === 'privacy' ? operator.privacyEmail : operator.contactEmail;
  return email || 'the operator of this service';
}
