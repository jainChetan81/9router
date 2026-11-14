import { getAdapter } from "@/lib/db/driver.js";
import { getLive } from "@/lib/agents/queries.js";
import { etagFor, liveVersionTag, notModified, responseHeaders, cacheHeaders, cachedResult, busyResponse } from "@/lib/agents/httpCache.js";
import { scheduleSessionBackfill } from "@/lib/agents/sessionBackfill.js";

export const dynamic = "force-dynamic";

// The live answer changes with the live version (a request started, streamed
// or finished) and, while it lists sessions, with the clock: sessions leave
// the 5-minute window without any event. So the ETag carries a 30 s time
// bucket only while the last answer had sessions. An idle gateway keeps one
// ETag and answers every poll 304 with no SQL.
const WINDOW_BUCKET_MS = 30_000;
const HOT_KEY = Symbol.for("9router.agents.live.hot");
const hot = globalThis[HOT_KEY] || (globalThis[HOT_KEY] = { value: true });

const isHot = (data) => (data?.sessions?.length || 0) > 0 || (data?.inFlight || 0) > 0;

export async function GET(request) {
  try {
    const now = Date.now();
    const versionTag = liveVersionTag(); // read before any work, so a bump during it is not lost
    const etagWhen = (hotNow) => etagFor("live", hotNow ? Math.floor(now / WINDOW_BUCKET_MS) : "", versionTag);
    const etag = etagWhen(hot.value);
    const unchanged = notModified(request, etag);
    if (unchanged) return unchanged;

    const db = await getAdapter();
    scheduleSessionBackfill(db);
    // No reuse across versions here: a client refetches because the version
    // moved, so an answer from before the move would stay on screen until the
    // next event. Clients on the same version share one result, and reads in
    // flight are shared by the read worker.
    const result = await cachedResult("live", etag, {
      ttlMs: 60_000,
      // Name the answer by what it turned out to be, so the first poll after
      // the feed goes idle (or wakes up) already holds the right ETag.
      etagOf: (data) => { hot.value = isHot(data); return etagWhen(hot.value); },
    }, () => getLive(db, now));
    return Response.json(result.data, { headers: cacheHeaders(result) });
  } catch (error) {
    if (error?.code === "busy") return busyResponse();
    return Response.json({ error: error.message }, { status: 500 });
  }
}
