"use client";

import { useState, useEffect, useRef } from "react";
import { createLiveClient } from "@/lib/live/client";

// One client (and so one EventSource) per tab; see src/lib/live/client.js.
let client = null;
function getClient() {
  if (client || typeof window === "undefined" || typeof EventSource === "undefined") return client;
  client = createLiveClient({
    createSource: (url) => new EventSource(url),
    isHidden: () => typeof document !== "undefined" && document.hidden,
  });
  document.addEventListener("visibilitychange", () => client.visibilityChanged());
  return client;
}

/**
 * Shared hook to subscribe to live topic updates.
 * Keeps exactly one EventSource per tab, closes on hidden, reopens on visible,
 * and reconnects with backoff after a fatal error.
 *
 * `version` is the server's version of the topic. `tick` moves on every server
 * event and also when the page must catch up by itself (tab visible again,
 * stream reconnected). Refetch on `tick`, not on `version`.
 *
 * @param {string} topic - e.g. "usage", "agents", "pii", "quota"
 * @param {object} [options]
 * @param {number} [options.throttleMs] - minimum interval between updates
 * @returns {{ version: number, tick: number, connected: boolean }}
 */
export function useLiveTopic(topic, options = {}) {
  const throttleMs = options?.throttleMs || 0;
  const [state, setState] = useState(() => getClient()?.snapshot(topic) || { version: 0, tick: 0 });
  const [connected, setConnected] = useState(() => !!getClient()?.isConnected());
  const lastUpdateRef = useRef(0);
  const pendingTimerRef = useRef(null);

  useEffect(() => {
    const live = getClient();
    if (!live) return;

    const onChange = (next) => {
      const now = Date.now();
      const elapsed = now - lastUpdateRef.current;
      if (!throttleMs || elapsed >= throttleMs) {
        lastUpdateRef.current = now;
        setState(next);
      } else if (!pendingTimerRef.current) {
        pendingTimerRef.current = setTimeout(() => {
          pendingTimerRef.current = null;
          lastUpdateRef.current = Date.now();
          setState(live.snapshot(topic));
        }, throttleMs - elapsed);
      }
    };

    const unsubscribe = live.subscribe(topic, onChange, setConnected);
    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [topic, throttleMs]);

  return { version: state.version, tick: state.tick, connected };
}
