/**
 * One JSON request at a time, for data where only the latest request counts
 * (stats for the selected period, say). A new call aborts the one in flight,
 * and an answer to an older call is marked `current: false`, so a slow
 * response for a previous choice never overwrites the newer one.
 *
 *   json(url)  -> { current, data }   data is null on an HTTP or network error
 *   cancel()   abort the request in flight; its answer is not current
 */
export function createLatestRequest(fetchImpl = (...args) => fetch(...args)) {
  let seq = 0;
  let controller = null;
  return {
    async json(url) {
      controller?.abort();
      const mine = ++seq;
      const own = (controller = new AbortController());
      let data = null;
      try {
        const res = await fetchImpl(url, { signal: own.signal });
        data = res.ok ? await res.json() : null;
      } catch {}
      return { current: mine === seq, data };
    },
    cancel() {
      seq++;
      controller?.abort();
      controller = null;
    },
  };
}
