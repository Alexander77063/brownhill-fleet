/** Per-tenant branding / customization. Stored in the existing `tenants.branding`
 *  jsonb (single source of truth — no second table to drift). Every field is
 *  optional; the app falls back to the Elite Fleet Management defaults when unset.
 *  Applied to: the portal shell (logo + name), outbound emails (from-name,
 *  reply-to, header/footer), and document letterheads (legal name, address, VAT).
 */
import { createServiceClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/auth/context";
import { deploymentBrand } from "@/lib/deployment/brand";

export interface TenantBranding {
  logo_url?: string;
  colour_primary?: string;
  colour_accent?: string;
  // Email
  email_from_name?: string;
  email_reply_to?: string;
  email_header?: string;
  email_footer?: string;
  // Letterhead / legal identity (documents: contracts, invoices, receipts)
  legal_name?: string;
  trading_name?: string;
  address?: string;
  phone?: string;
  email?: string;
  vat_number?: string;
  company_number?: string;
  contract_footer?: string;
}

/**
 * Fallbacks when a tenant has set no branding of its own.
 *
 * Derived from the build rather than hardcoded to the SaaS: a self-hosted
 * customer whose branding is not yet filled in should see their own product's
 * name, not the name of the platform it was built from.
 */
export const BRANDING_DEFAULTS = {
  name: deploymentBrand().productName,
  legal_name: deploymentBrand().productName,
} as const;

const STRING_KEYS: (keyof TenantBranding)[] = [
  "logo_url",
  "colour_primary",
  "colour_accent",
  "email_from_name",
  "email_reply_to",
  "email_header",
  "email_footer",
  "legal_name",
  "trading_name",
  "address",
  "phone",
  "email",
  "vat_number",
  "company_number",
  "contract_footer",
];

function coerce(raw: Record<string, unknown> | null | undefined): TenantBranding {
  const out: TenantBranding = {};
  if (!raw) return out;
  for (const k of STRING_KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v;
  }
  return out;
}

/** Read a tenant's branding (defaults to the current tenant). Uses the service
 *  client scoped to the tenant id — branding is non-secret but tenant-owned. */
export async function getBranding(tenantId?: string): Promise<TenantBranding> {
  const tid = tenantId ?? (await requireTenantContext()).tenantId;
  const sb = createServiceClient();
  const { data } = await sb.from("tenants").select("branding").eq("id", tid).maybeSingle();
  return coerce(data?.branding as Record<string, unknown> | null);
}

/** Merge a patch into the tenant's branding jsonb (empty strings clear a field). */
export async function saveBranding(
  patch: TenantBranding,
  tenantId: string,
): Promise<void> {
  const sb = createServiceClient();
  const { data } = await sb.from("tenants").select("branding").eq("id", tenantId).maybeSingle();
  const current = coerce(data?.branding as Record<string, unknown> | null);
  const next: Record<string, string> = { ...current } as Record<string, string>;
  for (const k of STRING_KEYS) {
    if (k in patch) {
      const v = patch[k];
      if (typeof v === "string" && v.trim() !== "") next[k] = v.trim();
      else delete next[k];
    }
  }
  await sb.from("tenants").update({ branding: next as never }).eq("id", tenantId);
}

/** The display name for a tenant (trading name → legal name → default). */
export function brandDisplayName(b: TenantBranding): string {
  return b.trading_name || b.legal_name || BRANDING_DEFAULTS.name;
}

/** The legal entity name for documents (letterhead). */
export function brandLegalName(b: TenantBranding): string {
  return b.legal_name || BRANDING_DEFAULTS.legal_name;
}

/**
 * The name of the business the current user deals with, for copy shown to
 * drivers.
 *
 * A driver hires from an operator, not from the software vendor. Text like
 * "Ask Elite Fleet Management about switching to Rent-to-Buy" names a company
 * the driver has never heard of and cannot ring; it should name the operator
 * whose vehicle they are sitting in. On a self-hosted install it is doubly
 * wrong, because that vendor is not a party to anything.
 *
 * Falls back to the build's product name only when a tenant has set no branding
 * at all, which first-run setup now prevents.
 */
export async function operatorName(tenantId?: string): Promise<string> {
  return brandDisplayName(await getBranding(tenantId));
}

/** The operator's legal entity name, for insurance and contract copy. */
export async function operatorLegalName(tenantId?: string): Promise<string> {
  return brandLegalName(await getBranding(tenantId));
}

/** Identity fields a tenant MUST provide before a contract can carry their name
 *  instead of the platform's. These are exactly the fields the standard contract
 *  templates hardcode a platform default for (name, address, phone, email), so
 *  without them a generated agreement would otherwise show the platform's real
 *  details. `logo`, `vat_number` and `company_number` are intentionally optional
 *  (a sole trader may have no company number) and simply render blank when unset. */
export interface BrandingCompleteness {
  complete: boolean;
  /** Human-readable labels of the required fields still missing. */
  missing: string[];
}

export function checkBrandingComplete(b: TenantBranding): BrandingCompleteness {
  const missing: string[] = [];
  if (!(b.legal_name || b.trading_name)) missing.push('Company name');
  if (!b.address) missing.push('Registered address');
  if (!b.phone) missing.push('Phone number');
  if (!b.email) missing.push('Contact email');
  return { complete: missing.length === 0, missing };
}

/** True when the tenant has set the identity fields a contract needs. */
export function isBrandingComplete(b: TenantBranding): boolean {
  return checkBrandingComplete(b).complete;
}

/** Per-tenant email From/Reply-To. Keeps the platform's verified sending address
 *  (Resend requires a verified domain) but overrides the display name, and sets
 *  Reply-To to the tenant's own address so replies reach them. */
export function brandEmailFrom(
  b: TenantBranding,
  platformFrom: string,
): { from: string; replyTo?: string } {
  const name = b.email_from_name || brandDisplayName(b);
  const addr = platformFrom.match(/<(.+)>/)?.[1] ?? platformFrom;
  return { from: `${name} <${addr}>`, replyTo: b.email_reply_to };
}

/** Wrap an email body with the tenant's header/footer (both optional). */
export function brandEmailWrap(b: TenantBranding, html: string): string {
  const header = b.email_header
    ? `<div style="margin-bottom:16px">${b.email_header}</div>`
    : "";
  const footer = b.email_footer
    ? `<div style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:8px">${b.email_footer}</div>`
    : "";
  return `${header}${html}${footer}`;
}
