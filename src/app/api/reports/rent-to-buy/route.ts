/**
 * Download the rent-to-buy report — CSV for the spreadsheet, printable HTML for
 * the board pack.
 *
 * The same house pattern as the VAT return: the format is a query parameter,
 * CSV comes down as an attachment and HTML renders in the browser so the
 * reader can print it to PDF (there is no PDF library in this build).
 *
 *   /api/reports/rent-to-buy?format=csv&audience=board
 *   /api/reports/rent-to-buy?format=html&audience=investor
 *
 * Gated on the same permissions the pages use: the board pack needs
 * `reports.board`, the investor pack needs `reports.investor` — and a
 * director holding `reports.board` may also look at the investor pack, because
 * the board previews what it sends.
 */
import { NextResponse } from 'next/server';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import { assembleRtbReportFor } from '@/lib/reports/rtb-data';
import { rtbReportCsv, rtbReportHtml } from '@/lib/reports/rtb-format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) return new NextResponse('Unauthorised', { status: 401 });

  const url = new URL(req.url);
  const format = url.searchParams.get('format') === 'html' ? 'html' : 'csv';
  const audience = url.searchParams.get('audience') === 'investor' ? 'investor' : 'board';

  const canBoard = contextCan(ctx, 'reports.board');
  const canInvestor = contextCan(ctx, 'reports.investor');
  if (audience === 'investor') {
    if (!canInvestor && !canBoard) return new NextResponse('Forbidden', { status: 403 });
  } else if (!canBoard) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const report = await assembleRtbReportFor(ctx.tenantId, audience).catch(() => null);
  if (!report) return new NextResponse('Report unavailable', { status: 500 });

  const stamp = report.generatedAt.slice(0, 10);
  const name = `rent-to-buy-${audience}-${stamp}`;

  if (format === 'csv') {
    return new NextResponse(rtbReportCsv(report), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}.csv"`,
      },
    });
  }
  return new NextResponse(rtbReportHtml(report), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
