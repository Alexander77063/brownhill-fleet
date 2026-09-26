// src/app/api/v1/accounting/reports/[type]/route.ts
// GET handler returning the four reports as JSON. The SaaS team's accountant
// export flow uses this; the UI pages in src/app/admin/accounting/reports/* are
// server-rendered and don't hit this route.

import { NextRequest, NextResponse } from 'next/server';
import { renderProfitAndLoss, renderBalanceSheet, renderCashflow, renderArAging } from '@/lib/accounting/reports';

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string }> }) {
  const { type } = await ctx.params;
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');
  const asOf = url.searchParams.get('as_of');

  try {
    if (type === 'pnl') {
      if (!from || !to) return NextResponse.json({ error: 'from + to required' }, { status: 400 });
      return NextResponse.json(await renderProfitAndLoss(new Date(from), new Date(to)));
    }
    if (type === 'balance-sheet') {
      if (!asOf) return NextResponse.json({ error: 'as_of required' }, { status: 400 });
      return NextResponse.json(await renderBalanceSheet(new Date(asOf)));
    }
    if (type === 'cashflow') {
      if (!from || !to) return NextResponse.json({ error: 'from + to required' }, { status: 400 });
      return NextResponse.json(await renderCashflow(new Date(from), new Date(to)));
    }
    if (type === 'ar-aging') {
      if (!asOf) return NextResponse.json({ error: 'as_of required' }, { status: 400 });
      return NextResponse.json(await renderArAging(new Date(asOf)));
    }
    return NextResponse.json({ error: `unknown report type: ${type}` }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'unknown' }, { status: 500 });
  }
}
