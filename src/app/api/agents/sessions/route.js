import { listSessionsPage } from "@/lib/agents/queries.js";
import { handleRangeGet } from "@/lib/agents/rangeRequest.js";

export const dynamic = "force-dynamic";

function pageOf(params) {
  const limitRaw = parseInt(params.get("limit"));
  return {
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100,
    cursor: params.get("cursor"),
  };
}

export function GET(request) {
  return handleRangeGet(request, "sessions", {
    floorMs: 5000,
    ttlMs: 5 * 60_000,
    keyOf: (params) => { const { limit, cursor } = pageOf(params); return `${limit}:${cursor || ""}`; },
    compute: (db, fromIso, toIso, params) => listSessionsPage(db, fromIso, toIso, pageOf(params)),
    shape: (range, result) => ({
      range,
      sessions: result.sessions,
      nextCursor: result.nextCursor,
      total: result.total,
      truncated: result.truncated,
    }),
  });
}
