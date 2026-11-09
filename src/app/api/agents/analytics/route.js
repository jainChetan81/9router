import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveRange, distinctFirstMs } from "@/lib/agents/range.js";
import { getAnalytics } from "@/lib/agents/queries.js";
import { cacheGet, cacheSet } from "@/lib/agents/cache.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const db = await getAdapter();
    const params = new URL(request.url).searchParams;
    const now = Date.now();
    const firstMs = await distinctFirstMs(db);
    const range = resolveRange(params, now, firstMs);
    const fromIso = new Date(range.from).toISOString();
    const toIso = new Date(range.to).toISOString();

    const cacheKey = `analytics:${range.preset}:${range.from}:${range.to}`;
    let data = cacheGet(cacheKey);
    if (data === undefined) {
      data = await getAnalytics(db, fromIso, toIso);
      cacheSet(cacheKey, data, 30000);
    }

    return NextResponse.json({
      range: { preset: range.preset, from: range.from, to: range.to },
      ...data,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error?.code === "busy") return NextResponse.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
