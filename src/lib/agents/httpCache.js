// ETag support for the Agents GET routes.
//
// An ETag names "the answer to this query at this live version". The live
// version is the pair of bus versions that can change Agents data: "agents"
// (in-flight registry) and "usage" (a usage row was saved). A request whose
// If-None-Match equals the current ETag is answered 304 before any SQL runs.
import { createHash, randomBytes } from "node:crypto";
import { version } from "../live/bus.js";
import { cacheGet, cacheSet } from "./cache.js";

// Bus versions restart at 0 with the process, so a per-boot id keeps an old
// tab's ETag from matching after a restart.
const BOOT_KEY = Symbol.for("9router.agents.httpCache.boot");
const BOOT_ID = globalThis[BOOT_KEY] || (globalThis[BOOT_KEY] = randomBytes(4).toString("hex"));

export function liveVersionTag() {
  return `${version("agents")}.${version("usage")}`;
}

/**
 * ETag for one query. `extra` holds anything else the answer depends on (a
 * time bucket). `versionTag` lets a caller pin the live version it read
 * before computing.
 */
export function etagFor(queryKey, extra = "", versionTag = liveVersionTag()) {
  // The query key can hold request text (a cursor), so only its digest goes
  // into the header value.
  const digest = createHash("sha256").update(String(queryKey)).digest("hex").slice(0, 16);
  return `W/"${BOOT_ID}.${versionTag}${extra === "" ? "" : `.${extra}`}.${digest}"`;
}

function matches(header, etag) {
  if (!header) return false;
  const bare = (tag) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

/** 304 response when the client already holds `etag`, else null. */
export function notModified(request, etag) {
  let header = null;
  try { header = request?.headers?.get?.("if-none-match") || null; } catch { header = null; }
  if (!matches(header, etag)) return null;
  return new Response(null, { status: 304, headers: responseHeaders(etag) });
}

export function responseHeaders(etag) {
  // no-cache: the browser may keep the body but must revalidate every time.
  return { ETag: etag, "Cache-Control": "private, no-cache" };
}

/**
 * Server-side result cache keyed by query, shared by every client.
 * A stored result is reused while its ETag is current, and for `floorMs`
 * after it was computed whatever the version, so a burst of bumps does not
 * turn into a burst of identical SQL. Returns { data, etag }; the ETag is the
 * one the data was computed under; `etagOf(data)` may refine it once the data
 * is known.
 */
export async function cachedResult(queryKey, etag, { floorMs = 0, ttlMs = 60_000, etagOf = null }, compute) {
  const hit = cacheGet(queryKey);
  if (hit && (hit.etag === etag || Date.now() - hit.at < floorMs)) return hit;
  const at = Date.now();
  const data = await compute();
  const entry = { data, etag: etagOf ? etagOf(data) : etag, at };
  cacheSet(queryKey, entry, ttlMs);
  return entry;
}

export function busyResponse() {
  return Response.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
}
