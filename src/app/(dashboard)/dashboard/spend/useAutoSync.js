"use client";
// Page auto-sync: a countdown that calls onSync every `seconds` (0 = off).
// syncNow() runs onSync at once and restarts the countdown. The interval
// lives in settings.dashboardSync (server), so every browser shares it.
//
// The countdown is a small store outside React state: the page that calls this hook does not re-render
// each second. SyncButton subscribes to it (`subscribe` / `getLeft`) and is the only thing that does.
// `left` is still returned for older callers, as the value at the last render of the page.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SYNC_DEFAULTS, createCountdown, syncSecondsFor } from "@/lib/dashboardSync";
import { cacheGet, cacheSet, isFresh } from "@/lib/clientCache";

const SETTINGS_KEY = "/api/settings#dashboardSync";
const SETTINGS_TTL_MS = 60_000;
let settingsRequest = null;

// Only the sync intervals, one request for every hook on the page, at most once a minute.
function readSyncSettings() {
  const hit = cacheGet(SETTINGS_KEY);
  if (isFresh(hit, SETTINGS_TTL_MS)) return Promise.resolve(hit.data);
  settingsRequest ||= fetch("/api/settings?fields=dashboardSync", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (!s) return null;
      cacheSet(SETTINGS_KEY, s.dashboardSync || {});
      return s.dashboardSync || {};
    })
    .finally(() => { settingsRequest = null; });
  return settingsRequest;
}

export default function useAutoSync(page, onSync) {
  const [seconds, setSecondsState] = useState(SYNC_DEFAULTS[page] ?? 0);
  const [saving, setSaving] = useState(false);
  const onSyncRef = useRef(onSync);
  const [countdown] = useState(() => createCountdown({ hidden: () => typeof document !== "undefined" && document.hidden }));
  useEffect(() => { onSyncRef.current = onSync; countdown.setOnFire(() => onSyncRef.current?.()); });

  // Read the saved interval (cached copy first, then the server).
  useEffect(() => {
    let off = false;
    const hit = cacheGet(SETTINGS_KEY);
    if (hit) setTimeout(() => { if (!off) setSecondsState(syncSecondsFor({ dashboardSync: hit.data }, page)); }, 0);
    readSyncSettings().then((dashboardSync) => {
      if (!off && dashboardSync) setSecondsState(syncSecondsFor({ dashboardSync }, page));
    }).catch(() => {});
    return () => { off = true; };
  }, [page]);

  // The countdown stops while the tab is hidden. Back on a visible tab it syncs at once if the
  // interval has passed, else it carries on.
  useEffect(() => {
    countdown.setSeconds(seconds);
    const onVisibility = () => countdown.visibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); countdown.stop(); };
  }, [seconds, countdown]);

  // Manual sync: runs `manual` (or onSync) now and restarts the countdown.
  const syncNow = useCallback((manual) => {
    (typeof manual === "function" ? manual : onSyncRef.current)?.();
    countdown.restart();
  }, [countdown]);

  const setSeconds = useCallback(async (next) => {
    setSecondsState(next);
    setSaving(true);
    try {
      const r = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboardSync: { [page]: next } }) });
      const s = await r.json().catch(() => null);
      if (r.ok && s) cacheSet(SETTINGS_KEY, s.dashboardSync || {});
    } catch { /* keep the local choice; the next page load reads the server value */ }
    finally { setSaving(false); }
  }, [page]);

  return useMemo(() => ({
    seconds, syncNow, setSeconds, saving,
    subscribe: countdown.subscribe, getLeft: countdown.getLeft,
    get left() { return countdown.getLeft(); },
  }), [seconds, syncNow, setSeconds, saving, countdown]);
}
