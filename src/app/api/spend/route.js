import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { DATA_FILE } from "@/lib/db/paths.js";
import { createReadPool } from "@/lib/db/readPool.js";
import { getSettings, updateSettings, getPricingForModel } from "@/lib/localDb";
import { SUBS, aggregateSpend, invalidateSpendCache } from "@/lib/spend/aggregate.js";
import { version as usageVersion } from "@/lib/live/bus.js";

export const dynamic = "force-dynamic";

// Aggregate runs on a read-only worker thread so the gateway event loop
// stays free. Falls back to inline (main-thread) execution when the
// adapter is not file-backed (sql.js).
const spendPool = createReadPool({ name: "spend", workerModuleUrl: new URL("@/lib/spend/aggregateWorker.js", import.meta.url).href });

async function aggregateOffThread(db, args) {
  try {
    return await spendPool.run(db, "aggregate", args, {
      key: JSON.stringify([args.params, args.fees, usageVersion("usage")]),
    });
  } catch (error) {
    if (error?.code === "busy") throw error;
    // Non-file-backed driver or worker failure: run inline as before.
    if (String(error?.message).includes("file-backed")) return aggregateSpend(db, args);
    throw error;
  }
}

// What-if targets: every provider/model pair seen in the last 60 days, with
// the same effective price the usage logger uses. Pairs change slowly, so
// the resolved list is cached for 10 minutes instead of a DISTINCT scan +
// one pricing lookup per pair on every request.
const WHATIF_TTL = 10 * 60_000;
let whatIfCache = null;
async function resolveWhatIfTargets(db) {
  if (whatIfCache && Date.now() - whatIfCache.at < WHATIF_TTL) return whatIfCache.value;
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
    const value = out.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
    whatIfCache = { at: Date.now(), value };
    return value;
  } catch {
    return whatIfCache?.value || [];
  }
}

const FEE_NUM = /^\d*\.?\d+$|^\d+\.$/;

export async function GET(request) {
  try {
    const db = await getAdapter();
    const params = new URL(request.url).searchParams;
    const settings = await getSettings();
    const fees = settings.spendFees || {};
    const v = usageVersion("usage");
    const etag = `"${createHash("sha1").update(`${v}|${params.toString()}|${JSON.stringify(fees)}`).digest("hex").slice(0, 20)}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
    }
    const payload = await aggregateOffThread(db, { params: Object.fromEntries(params), now: Date.now(), fees });
    const whatIfTargets = await resolveWhatIfTargets(db);
    return NextResponse.json({ ...payload, whatIfTargets }, { headers: { ETag: etag, "Cache-Control": "no-store" } });
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
    whatIfCache = null;
    return NextResponse.json({ fees });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
