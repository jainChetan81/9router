"use client";
// Page auto-sync: a countdown that calls onSync every `seconds` (0 = off).
// syncNow() runs onSync at once and restarts the countdown. The interval
// lives in settings.dashboardSync (server), so every browser shares it.
import { useCallback, useEffect, useRef, useState } from "react";
import { SYNC_DEFAULTS, syncSecondsFor } from "@/lib/dashboardSync";
import { cacheGet, cacheSet } from "@/lib/clientCache";

const SETTINGS_KEY = "/api/settings#dashboardSync";

export default function useAutoSync(page, onSync) {
  const [seconds, setSecondsState] = useState(SYNC_DEFAULTS[page] ?? 0);
  const [left, setLeft] = useState(0);
  const [saving, setSaving] = useState(false);
  const onSyncRef = useRef(onSync);
  useEffect(() => { onSyncRef.current = onSync; });

  // Read the saved interval (cached copy first, then the server).
  useEffect(() => {
    let off = false;
    const hit = cacheGet(SETTINGS_KEY);
    if (hit) setTimeout(() => { if (!off) setSecondsState(syncSecondsFor({ dashboardSync: hit.data }, page)); }, 0);
    fetch("/api/settings", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (off || !s) return;
      cacheSet(SETTINGS_KEY, s.dashboardSync || {});
      setSecondsState(syncSecondsFor(s, page));
    }).catch(() => {});
    return () => { off = true; };
  }, [page]);

  // Countdown, one tick per second, paused while the tab is hidden.
  // The count lives in a ref so onSync runs outside any state updater (no double fire in Strict Mode).
  const leftRef = useRef(0);
  useEffect(() => {
    if (!seconds) return;
    leftRef.current = seconds;
    const t0 = setTimeout(() => setLeft(seconds), 0);
    const iv = setInterval(() => {
      if (document.hidden) return;
      const next = leftRef.current - 1;
      if (next > 0) { leftRef.current = next; setLeft(next); return; }
      leftRef.current = seconds;
      setLeft(seconds);
      onSyncRef.current?.();
    }, 1000);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [seconds]);

  // Manual sync: runs `manual` (or onSync) now and restarts the countdown.
  const syncNow = useCallback((manual) => {
    (typeof manual === "function" ? manual : onSyncRef.current)?.();
    if (seconds) { leftRef.current = seconds; setLeft(seconds); }
  }, [seconds]);

  const setSeconds = useCallback(async (next) => {
    setSecondsState(next);
    leftRef.current = next;
    setLeft(next);
    setSaving(true);
    try {
      const r = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboardSync: { [page]: next } }) });
      const s = await r.json().catch(() => null);
      if (r.ok && s) cacheSet(SETTINGS_KEY, s.dashboardSync || {});
    } catch { /* keep the local choice; the next page load reads the server value */ }
    finally { setSaving(false); }
  }, [page]);

  return { seconds, left, syncNow, setSeconds, saving };
}
