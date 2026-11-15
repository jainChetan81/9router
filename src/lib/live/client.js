// Browser side of /api/live, without React: one EventSource per tab, shared by
// every subscriber. Kept apart from the hook so it can be tested with fakes.
//
// Each topic has two counters:
//   version  the server's version, exactly as the last event carried it
//   tick     moves on every server event AND on every local "refetch now"
//            (tab visible again, stream reconnected)
// They are separate on purpose. A local bump must never write into `version`:
// the next server event would then carry the same number and look like no
// change at all. Consumers refetch when `tick` moves.

// Wait before reconnecting after a fatal error (e.g. 429 at the connection
// limit, which leaves the EventSource closed for good). The last step repeats.
export const RECONNECT_DELAYS_MS = [2000, 5000, 15000, 60000];

const CLOSED = 2; // EventSource.CLOSED

/**
 * @param {object} env
 * @param {(url: string) => EventSource} env.createSource
 * @param {() => boolean} env.isHidden
 * @param {string} [env.url]
 * @param {typeof setTimeout} [env.setTimer]
 * @param {typeof clearTimeout} [env.clearTimer]
 */
export function createLiveClient({ createSource, isHidden, url = "/api/live", setTimer = setTimeout, clearTimer = clearTimeout }) {
  const listeners = new Map(); // topic -> Set<{ onChange, onStatus }>
  const versions = new Map(); // topic -> server version
  const ticks = new Map(); // topic -> local change counter
  let source = null;
  let connected = false;
  let retryTimer = null;
  let attempts = 0;
  // Events may have been missed: refetch everything on the next open.
  let catchUp = false;

  const snapshot = (topic) => ({ version: versions.get(topic) || 0, tick: ticks.get(topic) || 0 });

  function notify(topic) {
    ticks.set(topic, (ticks.get(topic) || 0) + 1);
    const set = listeners.get(topic);
    if (!set) return;
    const state = snapshot(topic);
    for (const l of set) { try { l.onChange(state); } catch {} }
  }
  function bumpAll() {
    for (const topic of listeners.keys()) notify(topic);
  }
  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    for (const set of listeners.values()) for (const l of set) { try { l.onStatus?.(value); } catch {} }
  }

  function scheduleRetry() {
    if (retryTimer || !listeners.size || isHidden()) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)];
    attempts++;
    retryTimer = setTimer(() => { retryTimer = null; open(); }, delay);
  }
  function cancelRetry() {
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
  }

  function open() {
    if (source || !listeners.size || isHidden()) return;
    cancelRetry();
    let es;
    try { es = createSource(url); } catch { catchUp = true; scheduleRetry(); return; }
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      attempts = 0;
      setConnected(true);
      if (catchUp) { catchUp = false; bumpAll(); }
    };
    es.addEventListener("v", (event) => {
      if (source !== es) return;
      try {
        const payload = JSON.parse(event.data);
        if (!payload || !payload.topic) return;
        versions.set(payload.topic, payload.v);
        notify(payload.topic);
      } catch {}
    });
    es.onerror = () => {
      if (source !== es) return;
      setConnected(false);
      catchUp = true;
      // CONNECTING: the browser retries by itself. CLOSED: it gave up (an
      // HTTP error such as 429), so reconnect here with backoff.
      if (es.readyState === CLOSED) {
        try { es.close(); } catch {}
        source = null;
        scheduleRetry();
      }
    };
  }

  function close() {
    cancelRetry();
    if (source) { try { source.close(); } catch {} source = null; }
    setConnected(false);
  }

  return {
    snapshot,
    isConnected: () => connected,
    /** Subscribe to a topic. Returns the unsubscribe function. */
    subscribe(topic, onChange, onStatus) {
      const entry = { onChange, onStatus };
      let set = listeners.get(topic);
      if (!set) listeners.set(topic, set = new Set());
      set.add(entry);
      open();
      return () => {
        set.delete(entry);
        if (!set.size && listeners.get(topic) === set) listeners.delete(topic);
        if (!listeners.size) { close(); attempts = 0; catchUp = false; }
      };
    },
    /** Call on every visibilitychange. Hidden: disconnect. Visible: reconnect and refetch. */
    visibilityChanged() {
      if (isHidden()) { close(); attempts = 0; return; }
      if (!listeners.size) return;
      // Refetch now for what was missed while hidden; the open that follows
      // needs no second catch-up.
      catchUp = false;
      open();
      bumpAll();
    },
  };
}
