import { getAnalytics } from "@/lib/agents/queries.js";
import { handleRangeGet } from "@/lib/agents/rangeRequest.js";

export const dynamic = "force-dynamic";

export function GET(request) {
  return handleRangeGet(request, "analytics", {
    floorMs: 30_000,
    ttlMs: 5 * 60_000,
    compute: (db, fromIso, toIso) => getAnalytics(db, fromIso, toIso),
    shape: (range, data) => ({ range, ...data }),
  });
}
