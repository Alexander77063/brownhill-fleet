/** Single source of truth for the legal documents + the current version. Pure (no
 *  server imports) so it's usable in client and server components. Bump LEGAL_VERSION
 *  whenever ANY document changes — every tenant is then required to re-accept. */

export const LEGAL_VERSION = '2026-07-30';
export const LEGAL_UPDATED = '30 July 2026';

/** The operating entity behind the platform. NOTE for Elite Solutions Hub Ltd:
 *  confirm the bracketed fields with your solicitor before launch. */
export const OPERATOR = {
  entity: 'Elite Solutions Hub Ltd',
  product: 'Elite Fleet Management',
  jurisdiction: 'England and Wales',
  companyNumber: '[company registration number]',
  registeredAddress: '[registered office address]',
  contactEmail: 'legal@elitesolutionshub.com',
  privacyEmail: 'privacy@elitesolutionshub.com',
  website: 'https://elitesolutionshub.com',
} as const;

export const LEGAL_DOCS = [
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'acceptable-use', title: 'Acceptable Use Policy' },
  { slug: 'dpa', title: 'Data Processing Addendum' },
] as const;

export type LegalSlug = (typeof LEGAL_DOCS)[number]['slug'];
