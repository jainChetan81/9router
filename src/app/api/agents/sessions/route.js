import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveRange, distinctFirstMs } from "@/lib/agents/range.js";
import { listSessionsPage } from "@/lib/agents/queries.js";
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

    const limitRaw = parseInt(params.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
    const cursor = params.get("cursor");

    const cacheKey = `sessions:${range.preset}:${range.from}:${range.to}:${limit}:${cursor || ""}`;
    let result = cacheGet(cacheKey);
    if (result === undefined) {
      result = await listSessionsPage(db, fromIso, toIso, { limit, cursor });
      cacheSet(cacheKey, result, 5000);
    }

    return NextResponse.json({
      range: { preset: range.preset, from: range.from, to: range.to },
      sessions: result.sessions,
      nextCursor: result.nextCursor,
      total: result.total,
      truncated: result.truncated,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error?.code === "busy") return NextResponse.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
