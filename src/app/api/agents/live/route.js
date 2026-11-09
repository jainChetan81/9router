import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getLive } from "@/lib/agents/queries.js";
import { cacheGet, cacheSet } from "@/lib/agents/cache.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const db = await getAdapter();
    const now = Date.now();
    let data = cacheGet("live");
    if (data === undefined) {
      data = await getLive(db, now);
      cacheSet("live", data, 1000);
    }
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error?.code === "busy") return NextResponse.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
