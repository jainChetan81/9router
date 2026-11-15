// GET helper for the Agents routes, kept free of React so it can be tested.
//
// The routes answer 304 when the data did not change; the last answer per URL
// is kept here with its ETag and reused as it is. Three things matter:
//   sync    "Sync now" asks for fresh data: no If-None-Match is sent (so no
//           304), and the x-9r-sync header tells the server to skip its own
//           caches as well.
//   reload  A floor window on the server can serve an older body. The route
//           then answers with `x-9r-retry-after-ms`, and `reload` runs once
//           after that delay. It is the caller's own loader, so the fresh
//           body goes through the same path into what is on screen. Without
//           a `reload` nothing is scheduled: a refetch nobody reads is waste.
import { syncHeaders } from "@/lib/dashboardSync";

export const ETAG_STORE_MAX = 24;

export function createEtagFetcher({ fetchImpl = (...a) => fetch(...a), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const etagStore = new Map(); // url -> { etag, body }, oldest first
  const retryTimers = new Map(); // url -> timer

  function cancelRetry(url) {
    if (!retryTimers.has(url)) return;
    clearTimer(retryTimers.get(url));
    retryTimers.delete(url);
  }

  async function getJson(url, { sync = false, reload = null } = {}) {
    cancelRetry(url);
    const known = sync ? null : etagStore.get(url);
    const headers = sync ? syncHeaders(true) : known ? { "If-None-Match": known.etag } : undefined;
    const res = await fetchImpl(url, { cache: "no-store", headers });
    if (res.status === 304 && known) return known.body;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    const etag = res.headers.get("etag");
    if (etag) {
      etagStore.delete(url);
      etagStore.set(url, { etag, body });
      while (etagStore.size > ETAG_STORE_MAX) etagStore.delete(etagStore.keys().next().value);
    }
    const retryAfter = parseInt(res.headers.get("x-9r-retry-after-ms"), 10);
    if (reload && Number.isFinite(retryAfter) && retryAfter > 0) {
      cancelRetry(url);
      retryTimers.set(url, setTimer(() => { retryTimers.delete(url); try { reload(); } catch {} }, retryAfter));
    }
    return body;
  }

  return {
    getJson,
    cancelRetries() { for (const url of [...retryTimers.keys()]) cancelRetry(url); },
    pendingRetries: () => retryTimers.size,
  };
}
