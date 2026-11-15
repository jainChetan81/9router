"use client";
// Sync control and freshness line for the Agents page.
//
// Live data arrives by push (see useLiveTopic in AgentsClient). This timer is
// the fallback and the manual "Sync now". It keeps its countdown state here,
// so the one-second countdown re-renders this small component and not the
// whole page. Without a saved interval it runs every 60 s (the shared
// dashboardSync default for Agents is still 10 s; that file belongs to
// another work package). Paused: the countdown stops and nothing fires.
import { useCallback, useEffect, useRef, useState } from "react";
import SyncButton from "../spend/SyncButton";
import { SYNC_CHOICES } from "@/lib/dashboardSync";
import { cacheGet, cacheSet } from "@/lib/clientCache";
import { AGENTS_SYNC_FALLBACK_S, agentsSyncSeconds, freshnessOf, istClock } from "./liveSync";

const SETTINGS_KEY = "/api/settings#dashboardSync";
const isSaved = (dashboardSync) => SYNC_CHOICES.includes(dashboardSync?.agents);

export function AgentsSyncControl({ onAuto, onManual, paused = false, busy = false }) {
  const [seconds, setSecondsState] = useState(AGENTS_SYNC_FALLBACK_S);
  // True once the user has saved an interval. Only then is the timer a real
  // sync that asks for fresh data; the unsaved fallback is a plain poll.
  const savedRef = useRef(false);
  const [left, setLeft] = useState(0);
  const [saving, setSaving] = useState(false);
  const onAutoRef = useRef(onAuto);
  useEffect(() => { onAutoRef.current = onAuto; });

  // Read the saved interval (cached copy first, then the server).
  useEffect(() => {
    let off = false;
    const hit = cacheGet(SETTINGS_KEY);
    if (hit) setTimeout(() => { if (!off) { savedRef.current = isSaved(hit.data); setSecondsState(agentsSyncSeconds(hit.data, SYNC_CHOICES)); } }, 0);
    fetch("/api/settings", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (off || !s) return;
      cacheSet(SETTINGS_KEY, s.dashboardSync || {});
      savedRef.current = isSaved(s.dashboardSync);
      setSecondsState(agentsSyncSeconds(s.dashboardSync, SYNC_CHOICES));
    }).catch(() => {});
    return () => { off = true; };
  }, []);

  // Countdown, one tick per second. Stops while paused or while the tab is hidden.
  const leftRef = useRef(0);
  useEffect(() => {
    if (!seconds || paused) return;
    leftRef.current = seconds;
    const t0 = setTimeout(() => setLeft(seconds), 0);
    const iv = setInterval(() => {
      if (document.hidden) return;
      const next = leftRef.current - 1;
      if (next > 0) { leftRef.current = next; setLeft(next); return; }
      leftRef.current = seconds;
      setLeft(seconds);
      onAutoRef.current?.(savedRef.current);
    }, 1000);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [seconds, paused]);

  const syncNow = useCallback(() => {
    onManual?.();
    if (seconds) { leftRef.current = seconds; setLeft(seconds); }
  }, [seconds, onManual]);

  const setSeconds = useCallback(async (next) => {
    setSecondsState(next);
    savedRef.current = true;
    leftRef.current = next;
    setLeft(next);
    setSaving(true);
    try {
      const r = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboardSync: { agents: next } }) });
      const s = await r.json().catch(() => null);
      if (r.ok && s) cacheSet(SETTINGS_KEY, s.dashboardSync || {});
    } catch { /* keep the local choice; the next page load reads the server value */ }
    finally { setSaving(false); }
  }, []);

  // While paused the countdown stays frozen at its last value.
  return <SyncButton sync={{ seconds, left, syncNow, setSeconds, saving }} busy={busy} />;
}

const DOT = { width: 8, height: 8, borderRadius: "50%", flex: "none", boxSizing: "border-box" };
const DOTS = {
  ok: { ...DOT, background: "var(--green)" },
  loading: { ...DOT, background: "var(--tx3)" },
  error: { ...DOT, background: "var(--red)" },
  paused: { ...DOT, border: "1.5px solid var(--tx3)" },
};
const COLORS = { ok: "var(--tx2)", loading: "var(--tx2)", error: "var(--red)", paused: "var(--tx2)" };

/** "Updated 12 s ago" with a Pause / Resume button. Ticks by itself every 5 s. */
export function Freshness({ okAt, failed, paused, onToggle }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t0 = setTimeout(() => setNow(Date.now()), 0); // new data: show its age at once
    const iv = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 5000);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [okAt, failed, paused]);
  const f = freshnessOf({ okAt, failed, paused, now });
  return (
    <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS[f.state], whiteSpace: "nowrap" }}>
      <span aria-hidden="true" style={DOTS[f.state]} />
      <span title={okAt ? "Last successful update " + istClock(okAt) : "No successful update yet"}>{f.text}</span>
      <button type="button" onClick={onToggle} aria-pressed={paused} title={paused ? "Resume automatic updates" : "Stop automatic updates. Sync now still works."} style={{ display: "inline-flex", alignItems: "center", gap: 3, height: 22, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 11, cursor: "pointer" }}>
        <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 14 }}>{f.icon}</span>{f.btn}
      </button>
    </span>
  );
}
