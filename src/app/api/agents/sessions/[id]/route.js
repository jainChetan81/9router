import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getSessionDetail } from "@/lib/agents/queries.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    let decodedId;
    try { decodedId = decodeURIComponent(id); }
    catch { return NextResponse.json({ error: "invalid id" }, { status: 400 }); }
    if (!/^[0-9a-f]{12}$/.test(decodedId)) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
    const db = await getAdapter();
    const detail = await getSessionDetail(db, decodedId);
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error?.code === "busy" || error?.status === 503) {
      return NextResponse.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
