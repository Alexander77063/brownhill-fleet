"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/context";
import { saveBranding, type TenantBranding } from "@/lib/branding";
import { storagePut } from "@/lib/storage";

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
// Raster only — SVG is intentionally excluded (a same-origin SVG can carry script).
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Upload a tenant logo: store the image and point logo_url at the stable public
 *  serve route (so it renders in the portal, emails and generated contracts). */
export async function uploadLogoAction(formData: FormData): Promise<{ error?: string }> {
  const ctx = await requirePermission("tenant.settings");
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return { error: "Please choose an image file." };
  if (!LOGO_TYPES.includes(file.type)) return { error: "Use a PNG, JPG, WEBP or GIF image." };
  if (file.size > MAX_LOGO_BYTES) return { error: "Logo must be under 2 MB." };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { ok } = await storagePut("branding", `${ctx.tenantId}/logo`, bytes, file.type);
  if (!ok) return { error: "The logo could not be stored — please try again." };

  const base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  // `v` cache-busts the 5-min CDN cache so a re-upload shows immediately.
  const url = `${base}/api/branding/logo/${ctx.tenantId}?v=${Date.now()}`;
  await saveBranding({ logo_url: url }, ctx.tenantId);
  revalidatePath("/admin/branding");
  revalidatePath("/ops");
  return {};
}

export async function removeLogoAction(): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  await saveBranding({ logo_url: "" }, ctx.tenantId);
  revalidatePath("/admin/branding");
  revalidatePath("/ops");
}

const FIELDS: (keyof TenantBranding)[] = [
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

/** Save the tenant's branding/customization. Gated to tenant admins/owners. */
export async function saveBrandingAction(formData: FormData): Promise<void> {
  const ctx = await requirePermission("tenant.settings");
  const patch: TenantBranding = {};
  for (const f of FIELDS) {
    // Every field is present in the form, so an empty value clears it.
    patch[f] = String(formData.get(f) ?? "");
  }
  await saveBranding(patch, ctx.tenantId);
  revalidatePath("/ops/settings/branding");
  revalidatePath("/ops");
}
