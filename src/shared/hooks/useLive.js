"use client";

import { useState, useEffect, useRef } from "react";

// Module-level shared state for the single tab-wide EventSource connection
let sharedEs = null;
let subscribersCount = 0;
const topicListeners = new Map(); // topic -> Set<callback>
const topicVersions = new Map(); // topic -> current integer version
let isConnected = false;
let visibilityListenerAttached = false;

function ensureSharedConnection() {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return;
  if (sharedEs || (typeof document !== "undefined" && document.hidden)) return;

  try {
    sharedEs = new EventSource("/api/live");

    sharedEs.onopen = () => {
      isConnected = true;
      notifyStatusChange();
    };

    sharedEs.addEventListener("v", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload || !payload.topic) return;
        const { topic, v, data } = payload;
        topicVersions.set(topic, v);
        notifyTopic(topic, v, data);
      } catch (err) {
        console.error("[useLive] parse error:", err);
      }
    });

    sharedEs.onerror = () => {
      isConnected = false;
      notifyStatusChange();
    };
  } catch (err) {
    console.error("[useLive] failed to connect:", err);
  }
}

function closeSharedConnection() {
  if (sharedEs) {
    sharedEs.close();
    sharedEs = null;
  }
  isConnected = false;
  notifyStatusChange();
}

function bumpAllActiveTopics() {
  for (const topic of topicListeners.keys()) {
    const current = topicVersions.get(topic) || 0;
    const next = current + 1;
    topicVersions.set(topic, next);
    notifyTopic(topic, next);
  }
}

function handleVisibilityChange() {
  if (typeof document === "undefined") return;
  if (document.hidden) {
    closeSharedConnection();
  } else {
    // When tab becomes visible: reopen connection and bump versions so consumers refetch
    if (subscribersCount > 0) {
      ensureSharedConnection();
      bumpAllActiveTopics();
    }
  }
}

function notifyTopic(topic, v, data) {
  const set = topicListeners.get(topic);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(v, data);
    } catch {}
  }
}

function notifyStatusChange() {
  for (const set of topicListeners.values()) {
    for (const cb of set) {
      try {
        cb(undefined, undefined, isConnected);
      } catch {}
    }
  }
}

/**
 * Shared hook to subscribe to live topic updates.
 * Keeps exactly one EventSource per tab, closes on hidden, reopens on visible.
 *
 * @param {string} topic - e.g. "usage", "agents", "pii", "quota"
 * @param {object} [options]
 * @param {number} [options.throttleMs] - minimum interval between version updates
 * @returns {{ version: number, connected: boolean }}
 */
export function useLiveTopic(topic, options = {}) {
  const throttleMs = options?.throttleMs || 0;
  const [version, setVersion] = useState(() => topicVersions.get(topic) || 0);
  const [connected, setConnected] = useState(() => isConnected);
  const lastUpdateRef = useRef(0);
  const pendingTimerRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!visibilityListenerAttached && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
      visibilityListenerAttached = true;
    }

    subscribersCount++;
    if (!topicListeners.has(topic)) {
      topicListeners.set(topic, new Set());
    }

    const onUpdate = (newVersion, data, statusConnected) => {
      if (statusConnected !== undefined) {
        setConnected(statusConnected);
      }
      if (newVersion === undefined) return;

      const now = Date.now();
      const elapsed = now - lastUpdateRef.current;

      if (!throttleMs || elapsed >= throttleMs) {
        lastUpdateRef.current = now;
        setVersion(newVersion);
      } else {
        if (!pendingTimerRef.current) {
          pendingTimerRef.current = setTimeout(() => {
            pendingTimerRef.current = null;
            lastUpdateRef.current = Date.now();
            setVersion(topicVersions.get(topic) || newVersion);
          }, throttleMs - elapsed);
        }
      }
    };

    topicListeners.get(topic).add(onUpdate);
    ensureSharedConnection();

    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      const listeners = topicListeners.get(topic);
      if (listeners) {
        listeners.delete(onUpdate);
        if (listeners.size === 0) {
          topicListeners.delete(topic);
        }
      }
      subscribersCount = Math.max(0, subscribersCount - 1);
      if (subscribersCount === 0) {
        closeSharedConnection();
      }
    };
  }, [topic, throttleMs]);

  return { version, connected };
}
