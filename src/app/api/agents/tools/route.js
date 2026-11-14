import { getTools } from "@/lib/agents/queries.js";
import { handleRangeGet } from "@/lib/agents/rangeRequest.js";

export const dynamic = "force-dynamic";

// Shape: { tools: [{name,calls,errors,errorPct,byRole:[{role,calls,errors}],topModel:{model,calls}}],
// topToolsByRole: [{role,tools:[{name,calls,errors}]}], sampled, truncated }.

export function GET(request) {
  return handleRangeGet(request, "tools", {
    floorMs: 30_000,
    ttlMs: 5 * 60_000,
    compute: (db, fromIso, toIso) => getTools(db, fromIso, toIso),
    shape: (range, data) => ({ range, ...data }),
  });
}
