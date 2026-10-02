/** AI report generation — the tenant clicks "Generate", the AI writes a report
 *  from their OWN data. This replaces the standalone investor portal + the static
 *  board-report page: investor updates and board packs are now generated on demand.
 *  Grounded in assembleBoardReport (the trustworthy computed bundle) + VAT; uses
 *  the tenant's own AI provider/key via runTenantAi (dormant-safe). */
import { requireTenantContext } from "@/lib/auth/context";
import { assembleBoardReport } from "@/lib/reports";
import { getVatByQuarter } from "@/lib/queries-portal";
import { runTenantAi, PLATFORM_REPORT_MODEL } from "@/lib/ops/assistant";

export interface ReportType {
  key: string;
  label: string;
  description: string;
  piiFree?: boolean;
}

export const REPORT_TYPES: ReportType[] = [
  { key: "board", label: "Board pack", description: "Operational + financial summary for a board meeting." },
  { key: "investor", label: "Investor update", description: "PII-free performance + returns summary for investors.", piiFree: true },
  { key: "vat", label: "VAT summary", description: "A written explanation of the quarterly VAT position." },
  { key: "performance", label: "Fleet performance", description: "Utilisation, revenue and risk across the fleet." },
];

export function isReportType(key: string): boolean {
  return REPORT_TYPES.some((r) => r.key === key);
}

/** Generate a written report of the given type from the tenant's live data. */
export async function generateReport(type: string): Promise<string> {
  const { tenantId } = await requireTenantContext();
  const spec = REPORT_TYPES.find((r) => r.key === type) ?? REPORT_TYPES[0];

  const [board, vat] = await Promise.all([
    assembleBoardReport(tenantId),
    getVatByQuarter().catch(() => []),
  ]);

  const context = JSON.stringify({ board, vatByQuarter: vat }, null, 2);

  const system = `You are a fleet-management analyst writing a concise, professional "${spec.label}" for a UK vehicle-rental operator. Use ONLY the numbers in the provided data — never invent figures. Money is integer pence; present it as GBP (e.g. 82500 → £825.00). Output clean GitHub-flavoured Markdown: a short title, a one-paragraph executive summary, then sections with headings and tight bullet points. Be specific and quote the real figures.${
    spec.piiFree
      ? " This report is for EXTERNAL INVESTORS — do NOT include any driver names or personal data; focus on occupancy, revenue, net position and headline risks."
      : ""
  }`;

  const user = `Data (JSON) for the ${spec.label}:\n\n${context}\n\n---\n\nWrite the ${spec.label} now.`;

  return runTenantAi(tenantId, system, [{ role: "user", content: user }], 2500, {
    platformModel: PLATFORM_REPORT_MODEL,
  });
}
