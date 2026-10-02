/**
 * In-app help content — the single source of truth for the ⓘ HelpHint tooltips
 * (and the setup guide). Keyed by a stable id so copy stays out of components,
 * is easy to audit, and can be translated later. Each entry answers "what is
 * this?" (body) and, where the feature needs configuring, "how do I set it up?"
 * (steps), with an optional link to a fuller guide.
 */
export interface HelpEntry {
  title: string;
  body: string;
  steps?: string[];
  docHref?: string;
}

const ENTRIES = {
  'payments.stripe_key': {
    title: 'Your Stripe secret key',
    body: 'Rent and charges are collected into your own Stripe account — the platform never touches the funds. Paste your live secret key (sk_live_…); it is encrypted at rest.',
    steps: ['In Stripe: Developers → API keys', 'Copy the Secret key', 'Paste it here and save'],
  },
  'payments.webhook_secret': {
    title: 'Stripe webhook signing secret',
    body: 'Lets us verify that payment events genuinely came from Stripe. Copy the webhook URL shown on this page into Stripe, then paste back the signing secret Stripe gives you.',
    steps: [
      'Copy the webhook URL shown on this page',
      'In Stripe: Developers → Webhooks → Add endpoint',
      'Paste the signing secret (whsec_…) here',
    ],
  },
  'payments.gocardless_token': {
    title: 'Your GoCardless access token',
    body: 'Direct-debit rent is collected into your own GoCardless account. Paste your access token; it is encrypted at rest. Choose Sandbox to test first.',
    steps: ['In GoCardless: Developers → Create access token', 'Copy the token', 'Choose Live or Sandbox and save'],
  },
  'assistant.api_key': {
    title: 'Bring your own AI key (optional)',
    body: 'AI is included with your plan. Advanced: connect your own provider key to run on your own account and model — it is encrypted at rest, and only your fleet’s own data is ever sent.',
    steps: ['Pick a provider', 'Paste your API key', 'Enable the assistant'],
  },
  'assistant.model': {
    title: 'Which model should I pick?',
    body: 'Faster, cheaper models handle day-to-day questions well; larger models write better long-form reports. If you’re unsure, leave the default — you can change it any time.',
  },
  'branding.legal_name': {
    title: 'Registered legal name',
    body: 'Appears on your letterhead, contracts and invoices. Use the exact name on your Companies House record so documents are legally accurate.',
  },
  'branding.vat_number': {
    title: 'VAT number',
    body: 'Shown on generated contracts and invoices and used across your HMRC VAT records. Enter your registered number (e.g. GB123456789). Leave blank if you’re not VAT-registered.',
  },
  'drivers.invite': {
    title: 'Inviting a driver',
    body: 'Sends the driver a secure sign-in link by email and provisions their account, so they can log into the driver app, upload documents and submit receipts. A driver cannot sign in until they’ve been invited.',
  },
  'tracking.devices': {
    title: 'How vehicle tracking works',
    body: 'A vehicle appears here once a device sends it GPS — either the driver app or a hardware tracker — authenticated by a per-vehicle token. No position is shown until a device is sending.',
  },
  'email.resend_key': {
    title: 'Your Resend API key',
    body: 'Driver reminders and alerts send from YOUR own email account, so they arrive from your domain — not the platform. Paste your Resend API key (starts with re_); it is encrypted at rest.',
    steps: ['Sign up at resend.com', 'API Keys → Create API Key → copy it (re_…)', 'Paste it here and enable'],
  },
  'email.from_address': {
    title: 'Your "from" address',
    body: 'The address drivers see messages come from — e.g. alerts@yourfleet.co.uk. It must be on a domain you have verified in Resend, or your provider will reject the send.',
    steps: ['In Resend: Domains → Add Domain', 'Add the DNS records it shows at your domain host', 'Once verified, use any address on that domain here'],
  },
  'email.enabled': {
    title: 'Turn email on',
    body: 'When on (and a key + verified from-address are set), your fleet’s reminders and alerts are emailed to drivers and to you. When off, nothing is sent — messages are still logged in the app.',
  },
  'sms.account_sid': {
    title: 'Your Twilio Account SID',
    body: 'Text messages to drivers send from YOUR own Twilio account. Your Account SID (starts with AC…) is on your Twilio Console dashboard.',
    steps: ['Sign up at twilio.com', 'Console dashboard → copy your Account SID (AC…)', 'Paste it here'],
  },
  'sms.auth_token': {
    title: 'Your Twilio Auth Token',
    body: 'Found next to your Account SID on the Twilio Console dashboard. Encrypted at rest; leave blank to keep your current token.',
  },
  'sms.from_number': {
    title: 'Your Twilio phone number',
    body: 'A number you’ve bought in Twilio (Phone Numbers → Buy a number) that texts are sent from — e.g. +447700900000. UK numbers work for UK drivers.',
    steps: ['In Twilio: Phone Numbers → Buy a number (SMS-capable)', 'Copy it in +E.164 format (+44…)', 'Paste it here'],
  },

  // ── Feature-level help: attached to each page header so a tenant admin can see
  //    what a feature does and how to set it up, right where they are. ─────────
  'page.admin': {
    title: 'Organisation & team',
    body: 'Your workspace settings: business name, the modules turned on for your fleet, your subscription plan, and who can log in. Changes here affect everyone in your organisation.',
    steps: ['Set your business name and turn on the modules you use', 'Add team members by email and give each a role', 'Manage your plan under Subscription'],
  },
  'page.agreements': {
    title: 'Hire agreements',
    body: 'Create standard rentals and rent-to-buy contracts, then generate a branded contract to e-sign. Weekly billing starts once an agreement is Active. Contracts are issued under your company, so set your Branding first.',
    steps: ['Add your company details in Settings → Branding', 'Pick a vehicle, a driver and the weekly terms', 'Create the agreement, then generate the contract to sign'],
  },
  'page.fleet': {
    title: 'Your fleet',
    body: 'Every vehicle with its hire status, occupancy and contracted economics. Enter a registration and the DVLA lookup fills the details for you. Select a vehicle for its full finance and history.',
    steps: ['Add a vehicle by registration (or bulk-import)', 'Confirm the DVLA-filled details and list value', 'Put it on hire by creating an agreement'],
  },
  'page.drivers': {
    title: 'Driver register',
    body: 'Your drivers with their PCO licences, DVLA checks and insurance. Inviting a driver provisions their login and driver app. Expiring licences are flagged automatically so nothing lapses.',
    steps: ['Invite a driver by name + email (creates their login)', 'Record their insurance and licence details', 'They sign in to the driver app to upload documents'],
  },
  'page.compliance': {
    title: 'Compliance & reminders',
    body: 'One view of MOT, insurance, PCO and finance milestones across the fleet, with reminders that chase themselves before anything expires. Connect email/SMS in Settings to have reminders sent automatically.',
    steps: ['Keep vehicle and driver records up to date', 'Connect email/SMS in Settings so reminders auto-send', 'Work the list — overdue and critical items surface first'],
  },
  'page.charges': {
    title: 'Charges & pass-through',
    body: 'PCNs, congestion and toll charges captured and passed through to the driver who had the vehicle at the time — automatically, with evidence attached. Import in bulk or add them one by one.',
    steps: ['Add or import a charge against the vehicle', 'The driver on hire at the time is matched for you', 'It’s passed through and chased with everything else'],
  },
  'page.finance': {
    title: 'Finance & VAT',
    body: 'Rent collection, reconciliation and VAT-ready ledgers — including an HMRC 9-box VAT return you can download. Payments reconcile against agreements so arrears are always current.',
    steps: ['Connect your payment provider in Settings → payments', 'Rent invoices raise weekly from active agreements', 'Download your VAT return when the period closes'],
  },
  'page.billing': {
    title: 'Rent & payments',
    body: 'Collect weekly rent into YOUR own Stripe or GoCardless account — the platform never touches your funds. Outstanding balances and arrears are tracked per agreement.',
    steps: ['Connect Stripe/GoCardless in Settings → payments', 'Weekly rent is collected from active agreements', 'Chase arrears from the outstanding list'],
  },
  'page.tracking': {
    title: 'Live tracking',
    body: 'Live vehicle position, trip history and geofence alerts. A vehicle appears once a device sends GPS — the driver app or a hardware tracker — so there’s nothing to switch on to get started.',
    steps: ['Enable the driver app’s location, or fit a tracker', 'Vehicles appear here as soon as they report a position', 'Set geofence rules under Settings → Tracking rules'],
  },
  'page.bookings': {
    title: 'Dispatch & B2B bookings',
    body: 'Corporate accounts, standing bookings and account billing for your business clients — bill on account rather than per trip.',
    steps: ['Add a corporate account and its billing terms', 'Take bookings against the account', 'Invoice the account on your billing cycle'],
  },
  'page.reports': {
    title: 'Reports',
    body: 'Board, investor and VAT-ready reports generated on demand from your own fleet data by the AI assistant. Included with your plan — no setup needed.',
    steps: ['Pick the report you need', 'The assistant drafts it from your live data', 'Review, then export or share'],
  },
} satisfies Record<string, HelpEntry>;

export type HelpKey = keyof typeof ENTRIES;

// Widen each value to the full HelpEntry so optional fields (steps, docHref) are
// accessible, while keeping the literal key union above.
export const HELP: Record<HelpKey, HelpEntry> = ENTRIES;
