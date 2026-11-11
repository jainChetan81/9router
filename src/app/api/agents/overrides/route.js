// Batch read of routing overrides for many sessions. The Agents page calls
// this once per sync instead of one `/api/agents/sessions/[id]/overrides`
// request per live session. Writes stay on the per-session route.

import { NextResponse } from "next/server";
import { isValidSession, listOverrideRevisions, listOverrides, loadOverrides } from "@/lib/agents/overrideStore.js";

export const dynamic = "force-dynamic";

const MAX_IDS = 200;
const NO_STORE = { "Cache-Control": "no-store" };

// Parses `ids=a,b,c` into unique, lower-case session ids. Skips invalid ids,
// so one bad id does not fail the batch. Returns null above MAX_IDS.
function parseIds(raw) {
  if (typeof raw !== "string" || !raw) return [];
  const ids = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(isValidSession))];
  return ids.length > MAX_IDS ? null : ids;
}

export async function GET(request) {
  const ids = parseIds(new URL(request.url).searchParams.get("ids"));
  if (!ids) return NextResponse.json({ error: "Invalid ids" }, { status: 400, headers: NO_STORE });
  try {
    await loadOverrides();
    const entries = await Promise.all(ids.map(async (sid) => {
      const [overrides, revisions] = await Promise.all([listOverrides(sid), listOverrideRevisions(sid)]);
      return [sid, { overrides, revisions }];
    }));
    return NextResponse.json({ sessions: Object.fromEntries(entries) }, { headers: NO_STORE });
  } catch (error) {
    if (error?.code === "busy") return NextResponse.json({ error: "busy" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "1" } });
    return NextResponse.json({ error: "Unable to load overrides" }, { status: 500, headers: NO_STORE });
  }
}
