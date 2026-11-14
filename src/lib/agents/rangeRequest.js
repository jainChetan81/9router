// Shared request handling for the range routes (sessions, analytics, tools):
// resolve the range, answer 304 from the ETag before any SQL, otherwise
// compute once per live version and share the result between clients.
import { getAdapter } from "../db/driver.js";
import { resolveRange, distinctFirstMs, cachedFirstMs } from "./range.js";
import { etagFor, notModified, responseHeaders, cacheHeaders, cachedResult, busyResponse } from "./httpCache.js";
import { scheduleSessionBackfill } from "./sessionBackfill.js";

/**
 * @param request   the GET request
 * @param name      cache namespace ("sessions", "analytics", "tools")
 * @param options   { floorMs, ttlMs, keyOf(params) -> extra key, compute(db, fromIso, toIso, params), shape(range, data) }
 */
export async function handleRangeGet(request, name, { floorMs, ttlMs, keyOf = () => "", compute, shape }) {
  try {
    const params = new URL(request.url).searchParams;
    const now = Date.now();
    // Only the "All" preset needs the oldest row; other presets resolve
    // without touching the database.
    const needsFirst = params.get("preset") === "All";
    let db = null;
    let firstMs = now;
    if (needsFirst) {
      db = await getAdapter();
      firstMs = cachedFirstMs(db, now) ?? await distinctFirstMs(db);
    }
    const range = resolveRange(params, now, firstMs);
    const queryKey = `${name}:${range.preset}:${range.from}:${range.to}:${keyOf(params)}`;
    const etag = etagFor(queryKey);
    const unchanged = notModified(request, etag);
    if (unchanged) return unchanged;

    db ||= await getAdapter();
    scheduleSessionBackfill(db);
    const fromIso = new Date(range.from).toISOString();
    const toIso = new Date(range.to).toISOString();
    const result = await cachedResult(queryKey, etag, { floorMs, ttlMs }, () => compute(db, fromIso, toIso, params));
    return Response.json(
      shape({ preset: range.preset, from: range.from, to: range.to }, result.data),
      { headers: cacheHeaders(result) }
    );
  } catch (error) {
    if (error?.code === "busy" || error?.status === 503) return busyResponse();
    return Response.json({ error: error.message }, { status: 500 });
  }
}
