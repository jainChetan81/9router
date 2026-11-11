import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings, updateSettings, getPricingForModel } from "@/lib/localDb";
import { SUBS, aggregateSpend, invalidateSpendCache } from "@/lib/spend/aggregate.js";

export const dynamic = "force-dynamic";

// What-if targets: every provider/model pair seen in the last 60 days, with the
// same effective price the usage logger uses (user override, then defaults).
async function resolveWhatIfTargets(db) {
  try {
    const rows = db.all(`SELECT DISTINCT provider, model FROM usageHistory
      WHERE timestamp >= ? AND provider IS NOT NULL AND model IS NOT NULL AND model != 'invalid' LIMIT 500`,
      [new Date(Date.now() - 60 * 86400000).toISOString()]);
    const out = [];
    for (const { provider, model } of rows) {
      const p = await getPricingForModel(provider, model);
      if (p && Number.isFinite(p.input) && Number.isFinite(p.output) && (p.input > 0 || p.output > 0)) {
        out.push({ provider, model, price: { input: p.input, output: p.output, cached: p.cached, cache_creation: p.cache_creation, reasoning: p.reasoning } });
      }
    }
    return out.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  } catch {
    return [];
  }
}

const FEE_NUM = /^\d*\.?\d+$|^\d+\.$/;

export async function GET(request) {
  try {
    const db = await getAdapter();
    const params = new URL(request.url).searchParams;
    const settings = await getSettings();
    const payload = aggregateSpend(db, { params, now: Date.now(), fees: settings.spendFees || {} });
    const whatIfTargets = await resolveWhatIfTargets(db);
    return NextResponse.json({ ...payload, whatIfTargets }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Monthly subscription fees, used for the value-per-USD ratio.
export async function PATCH(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }
    if (body.fees !== undefined && (typeof body.fees !== "object" || body.fees === null || Array.isArray(body.fees))) {
      return NextResponse.json({ error: "Invalid fees payload" }, { status: 400 });
    }
    const fees = {};
    for (const s of SUBS) {
      const v = body?.fees?.[s.k];
      // Blank, null, or whitespace-only clears the fee.
      if (v === undefined || v === null) continue;
      if (typeof v === "string") {
        const trimmed = v.trim();
        if (trimmed === "") continue;
        if (!FEE_NUM.test(trimmed)) return NextResponse.json({ error: `Invalid fee for ${s.name}` }, { status: 400 });
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n < 0 || n > 100000) return NextResponse.json({ error: `Invalid fee for ${s.name}` }, { status: 400 });
        fees[s.k] = n;
      } else if (typeof v === "number") {
        if (!Number.isFinite(v) || v < 0 || v > 100000) return NextResponse.json({ error: `Invalid fee for ${s.name}` }, { status: 400 });
        fees[s.k] = v;
      } else {
        return NextResponse.json({ error: `Invalid fee for ${s.name}` }, { status: 400 });
      }
    }
    await updateSettings({ spendFees: fees });
    const db = await getAdapter();
    invalidateSpendCache(db);
    return NextResponse.json({ fees });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
