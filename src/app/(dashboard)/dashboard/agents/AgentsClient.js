"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RangeBar from "../spend/RangeBar";
import PageHeader from "../spend/PageHeader";
import { buildView } from "./view";
import "../spend/spend.css";
import "../spend/shared-page.css";
import "./agents.css";

let detailRequestSequence = 0;
const overrideRequestIds = new Map();

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// The live feed polls every 2 seconds. Tool telemetry loads on range changes.
export default function AgentsClient() {
  const [range, setRange] = useState({ preset: "7D" });
  const [live, setLive] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [totalSessions, setTotalSessions] = useState(0);
  const [moreCursor, setMoreCursor] = useState(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailsBySession, setDetailsBySession] = useState({});
  const [detailLoad, setDetailLoad] = useState({ sid: null, status: "idle" });
  const [analytics, setAnalytics] = useState(null);
  const [tools, setTools] = useState(null);
  const [toolsError, setToolsError] = useState("");
  const [combos, setCombos] = useState([]);
  const [models, setModels] = useState([]);
  const [overridesBySession, setOverridesBySession] = useState({});
  const [draft, setDraft] = useState({});
  const [cf, setCf] = useState(false);
  const [toast, setToast] = useState(null);
  const [retryRouting, setRetryRouting] = useState(null);
  const [mode, setMode] = useState("loading");
  const [errorText, setErrorText] = useState("");
  const [ui, setUi] = useState({ tab: "live", paused: false, ago: 0, q: "", fClient: "", fRole: "", sel: null, exp: {}, focus: null, hov: null, pick: null, zoom: null, gOff: 0, drawer: null, drawerMode: "routing", conflict: null });
  const set = useCallback((p) => setUi((u) => ({ ...u, ...(typeof p === "function" ? p(u) : p) })), []);
  const closeDrawer = useCallback(() => { setDraft({}); setCf(false); set({ drawer: null, conflict: null }); }, [set]);
  const [theme, setTheme] = useState("light");
  const [vw, setVw] = useState(1440);
  const [tabsAtEnd, setTabsAtEnd] = useState(true);
  const tabsScrollRef = useRef(null);
  const [tick, setTick] = useState(0); // bump to force live + range + detail reloads

  useEffect(() => {
    Promise.all([getJson("/api/combos"), getJson("/api/models")]).then(([c, m]) => {
      setCombos(c.combos || []); setModels(m.models || []);
    }).catch(() => {});
  }, []);

  const refreshOverrides = useCallback(async (sid) => {
    if (!sid) return {};
    const requestId = (overrideRequestIds.get(sid) || 0) + 1;
    overrideRequestIds.set(sid, requestId);
    const data = await getJson(`/api/agents/sessions/${encodeURIComponent(sid)}/overrides`);
    if (overrideRequestIds.get(sid) === requestId) {
      setOverridesBySession((old) => ({ ...old, [sid]: { overrides: data.overrides || [], revisions: data.revisions || {} } }));
    }
    return data;
  }, []);
  const applyOverrides = useCallback(async (sid, changes) => {
    const saved = [];
    let auditWarning = false;
    try {
      let failure = null;
      for (const change of changes) {
        const res = await fetch(`/api/agents/sessions/${encodeURIComponent(sid)}/overrides`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ combo: change.role, model: change.to, expectedCurrent: change.expectedCurrent, mode: change.mode, fallback: change.mode === "member", expiry: change.expiry === "Session end" ? "session" : change.expiry, revision: overridesBySession[sid]?.revisions?.[change.role] ?? 0, confirmExpensive: !!change.warn }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { failure = { status: res.status, role: change.role, currentModel: body.currentModel || "unknown", message: body.error || "Unable to save routing" }; break; }
        saved.push(change.role);
        auditWarning ||= !!body.auditWarning;
      }
      if (saved.length) await refreshOverrides(sid);
      const unsaved = changes.filter((change) => !saved.includes(change.role));
      if (failure) {
        setDraft((old) => Object.fromEntries(Object.entries(old).filter(([role]) => unsaved.some((change) => change.role === role))));
        setRetryRouting(null);
        if (failure.status === 409) set((u) => ({ ...u, conflict: { role: failure.role, currentModel: failure.currentModel } }));
        setToast(saved.length ? `${saved.join(", ")} saved; ${unsaved.map((change) => change.role).join(", ")} still need saving.` : failure.message);
        return;
      }
      setDraft({});
      setRetryRouting(null);
      setToast(auditWarning ? "Routing saved, but the audit entry could not be recorded." : "Routing saved for s·" + sid + " · applies from the next request");
    } catch {
      const unsaved = changes.filter((change) => !saved.includes(change.role));
      if (saved.length) {
        setDraft((old) => Object.fromEntries(Object.entries(old).filter(([role]) => unsaved.some((change) => change.role === role))));
        await refreshOverrides(sid).catch(() => {});
        setRetryRouting(null);
        setToast(`${saved.join(", ")} saved; ${unsaved.map((change) => change.role).join(", ")} still need saving.`);
      } else {
        setRetryRouting({ sid, changes });
        setToast("Could not apply routing. Try again.");
      }
    }
  }, [refreshOverrides, overridesBySession, set]);
  const revertOverride = useCallback(async (sid, role, revision, entry) => {
    try {
      const q = new URLSearchParams({ combo: role, revision: String(revision ?? entry?.revision ?? 0) });
      const res = await fetch(`/api/agents/sessions/${encodeURIComponent(sid)}/overrides?${q}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) { await refreshOverrides(sid); setToast("Changed elsewhere. Reloaded."); return; }
      if (!res.ok) throw new Error(body.error || "Unable to revert routing");
      await refreshOverrides(sid);
      setToast(body.auditWarning ? role + " reverted; audit entry could not be recorded." : role + " reverted to " + (entry?.from || "combo default"));
    } catch (error) { setToast(error.message || "Unable to revert routing."); }
  }, [refreshOverrides]);
  useEffect(() => {
    if (!ui.drawer) return;
    const timer = setTimeout(() => refreshOverrides(ui.drawer).catch(() => setToast("Unable to load routing overrides.")), 0);
    return () => clearTimeout(timer);
  }, [ui.drawer, refreshOverrides]);
  const lastOverridePoll = useRef(0);
  useEffect(() => {
    const ids = (live?.sessions || []).map((s) => s.session).filter(Boolean);
    if (!ids.length) return;
    const now = Date.now();
    if (now - lastOverridePoll.current < 10000) return;
    lastOverridePoll.current = now;
    let cancelled = false;
    Promise.all(ids.map(async (sid) => {
      try {
        const requestId = (overrideRequestIds.get(sid) || 0) + 1;
        overrideRequestIds.set(sid, requestId);
        const d = await getJson(`/api/agents/sessions/${encodeURIComponent(sid)}/overrides`);
        return [sid, { overrides: d.overrides || [], revisions: d.revisions || {}, requestId }];
      } catch { return [sid, null]; }
    })).then((entries) => {
      if (!cancelled) setOverridesBySession((old) => ({ ...old, ...Object.fromEntries(entries.filter(([sid, value]) => value !== null && overrideRequestIds.get(sid) === value.requestId).map(([sid, value]) => [sid, { overrides: value.overrides, revisions: value.revisions }])) }));
    });
    return () => { cancelled = true; };
  }, [live]);

  useEffect(() => {
    const el = document.documentElement, sync = () => setTheme(el.classList.contains("dark") ? "dark" : "light");
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    const update = () => setTabsAtEnd(el.scrollWidth <= el.clientWidth + 1 || el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
    update(); el.addEventListener("scroll", update, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update); resize?.observe(el); if (el.firstElementChild) resize?.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", update); resize?.disconnect(); };
  }, []);

  const liveId = useRef(0);
  const uiRef = useRef(ui);
  useEffect(() => { uiRef.current = ui; });
  const loadLive = useCallback(async () => {
    const id = ++liveId.current;
    try {
      const d = await getJson("/api/agents/live");
      if (id !== liveId.current) return;
      setLive(d);
      set((u) => ({ ...u, ago: 0 }));
    } catch {
      if (id !== liveId.current) return;
      setMode((m) => (m === "ready" || m === "stale" ? "stale" : m));
    }
  }, [set]);
  useEffect(() => { const t = setTimeout(loadLive, 0); return () => clearTimeout(t); }, [loadLive, tick]);

  // Live poll: every 2 s, skipped while paused or when the tab is hidden.
  useEffect(() => {
    let t = null;
    const paused = () => uiRef.current.paused;
    const tick2 = () => { if (!document.hidden && !paused()) { setTick((x) => x + 1); } };
    const vis = () => { if (!document.hidden && !paused()) setTick((x) => x + 1); };
    tick2();
    t = setInterval(tick2, 2000);
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => set((u) => ({ ...u, ago: Math.min(999, (u.ago || 0) + 2) })), 2000);
    return () => clearTimeout(t);
  }, [tick, set]);


  const rangeId = useRef(0);
  const loadRange = useCallback(async () => {
    const id = ++rangeId.current;
    const q = new URLSearchParams({ preset: range.preset });
    if (range.preset === "Custom") { q.set("from", range.from); q.set("to", range.to); }
    try {
      const [s, a] = await Promise.all([getJson(`/api/agents/sessions?${q}`), getJson(`/api/agents/analytics?${q}`)]);
      if (id !== rangeId.current) return;
      setSessions(s.sessions || []);
      setTotalSessions(s.total ?? (s.sessions || []).length);
      setMoreCursor(s.nextCursor || null);
      setAnalytics(a);
      setMode("ready");
    } catch (e) {
      if (id !== rangeId.current) return;
      setErrorText(e.message || "Request failed");
      setMode((m) => (m === "ready" || m === "stale" ? "stale" : "error"));
    }
  }, [range]); // tick re-arms loadRange via the effect below, not the closure
  useEffect(() => { const t = setTimeout(loadRange, 0); return () => clearTimeout(t); }, [loadRange, tick]);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ preset: range.preset });
    if (range.preset === "Custom") { q.set("from", range.from); q.set("to", range.to); }
    getJson(`/api/agents/tools?${q}`).then((data) => {
      if (!cancelled) { setTools(data); setToolsError(""); }
    }).catch((error) => {
      if (!cancelled) { setTools(null); setToolsError(error.message || "Request failed"); }
    });
    return () => { cancelled = true; };
  }, [range]);

  const loadDetail = useCallback(async (sid) => {
    if (!sid) { setDetail(null); setDetailLoad({ sid: null, status: "idle" }); return; }
    const id = ++detailRequestSequence;
    setDetailLoad({ sid, status: "loading" });
    try {
      const d = await getJson(`/api/agents/sessions/${encodeURIComponent(sid)}`);
      if (id !== detailRequestSequence) return;
      setDetail(d);
      setDetailsBySession((old) => ({ ...old, [sid]: d }));
      setDetailLoad({ sid, status: "ready" });
    } catch { if (id !== detailRequestSequence) return; setDetail(null); setDetailLoad({ sid, status: "error" }); }
  }, []);
  // Select the first row only once, when nothing is selected. Live refreshes keep the selection (A15).
  const firstSid = sessions?.[0]?.session || null;
  const selInit = useRef(false);
  const initialSelPending = useRef(false);
  useEffect(() => {
    if (!selInit.current) {
      selInit.current = true;
      const fromUrl = new URLSearchParams(window.location.search).get("s");
      if (fromUrl) {
        initialSelPending.current = true;
        const timer = setTimeout(() => { initialSelPending.current = false; set({ sel: fromUrl }); }, 0);
        return () => clearTimeout(timer);
      }
    }
    if (initialSelPending.current || ui.sel || !firstSid) return;
    const timer = setTimeout(() => set({ sel: firstSid }), 0);
    return () => clearTimeout(timer);
  }, [ui.sel, firstSid, set]);
  useEffect(() => {
    if (!ui.sel) return;
    const url = new URL(window.location.href); url.searchParams.set("s", ui.sel); window.history.replaceState({}, "", url);
  }, [ui.sel]);
  const sel = ui.sel || null;
  useEffect(() => {
    if (ui.tab !== "sessions" || !sel) return;
    const t = setTimeout(() => loadDetail(sel), 0);
    return () => clearTimeout(t);
  }, [ui.tab, sel, tick, loadDetail]);

  const loadMore = useCallback(async () => {
    if (!moreCursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const q = new URLSearchParams({ preset: range.preset, cursor: moreCursor });
      if (range.preset === "Custom") { q.set("from", range.from); q.set("to", range.to); }
      const page = await getJson(`/api/agents/sessions?${q}`);
      setSessions((old) => {
        const seen = new Set((old || []).map((s) => s.session));
        return [...(old || []), ...(page.sessions || []).filter((s) => !seen.has(s.session))];
      });
      setMoreCursor(page.nextCursor || null);
    } catch (error) {
      setToast(error.message || "Unable to load more sessions.");
    } finally { setMoreBusy(false); }
  }, [moreCursor, moreBusy, range]);

  // Prime the mode once live answers arrive.
  useEffect(() => {
    if (!live || mode !== "loading") return;
    const t = setTimeout(() => setMode("ready"), 0);
    return () => clearTimeout(t);
  }, [live, mode]);

  const act = useMemo(() => ({
    tab: (k) => set({ tab: k }),
    pause: () => set((u) => ({ ...u, paused: !u.paused, ago: 0 })),
    retry: () => { setMode("loading"); setTick((x) => x + 1); },
    setQ: (q) => set({ q }),
    setClient: (c) => set({ fClient: c }),
    setRole: (r) => set({ fRole: r }),
    setToolRole: (r) => set({ toolRole: r }),
    setPreset: (preset) => { setRange({ preset }); set({ hover: null, pick: null, focus: null }); },
    select: (rootId, sid) => { set((u) => ({ ...u, sel: sid, focus: null, hov: null, pick: null, exp: sid === rootId ? u.exp : { ...u.exp, [rootId]: true } })); setTick((x) => x + 1); },
    toggleExpand: (sid) => set((u) => ({ ...u, exp: { ...u.exp, [sid]: !(u.exp[sid] ?? (u.sel === sid)) } })),
    focus: (f) => set((u) => ({ ...u, focus: f })),
    hover: (h) => set({ hov: h }),
    pick: (p) => set({ pick: p }),
    zoom: (k) => set({ zoom: k, gOff: 0 }),
    pan: (d) => set((u) => ({ ...u, gOff: Math.max(0, (u.gOff || 0) + d) })),
    // Every drawer opens from a clean draft, so no edit from another session or an earlier open leaks in (A6).
    openDrawer: (sid, kind = "routing") => { setDraft({}); setCf(false); set({ drawer: sid, drawerMode: kind, conflict: null }); if (sid) loadDetail(sid); else setOverrides([]); },
    openDetails: (sid) => { setDraft({}); setCf(false); set({ drawer: sid, drawerMode: "details", conflict: null }); loadDetail(sid); },
    openRouting: (sid) => { setDraft({}); setCf(false); set({ drawer: sid, drawerMode: "routing", conflict: null }); loadDetail(sid); },
    reloadRouting: async (sid) => { await refreshOverrides(sid); set({ conflict: null }); setDraft({}); },
    reloadSession: loadDetail,
    copySession: async (sid) => { try { await navigator.clipboard.writeText(sid); setToast("Copied"); } catch { setToast("Could not copy session ID."); } },
    loadMore,
    openTimeline: (sid) => { if (sid) { set({ tab: "sessions", sel: sid }); } else set({ tab: "sessions" }); setTick((x) => x + 1); },
  }), [set, loadMore, loadDetail, refreshOverrides]);

  const drawerOverrideState = overridesBySession[ui.drawer] || {};
  const v = buildView({ live, sessions, totalSessions, detail, detailsBySession, detailLoad, analytics, tools, range, ui: { ...ui, mode, errorText }, vw, combos, models, overrides: drawerOverrideState.overrides || [], overridesBySession, revisions: drawerOverrideState.revisions || {}, draft, cf, toast, moreCursor,
    setDraft: (update) => setDraft((old) => ({ ...old, ...(typeof update === "function" ? update(old) : update) })),
    setCf, setToast, applyOverrides, reloadOverrides: refreshOverrides,
    act: { ...act, applyOverrides, revertOverride } });

  const isLoading = mode === "loading", isError = mode === "error", ready = !isLoading && !isError;
  const onRange = (r) => { setRange(r); set({ hov: null, pick: null, focus: null, sel: null }); setDetail(null); const url = new URL(window.location.href); url.searchParams.delete("s"); window.history.replaceState({}, "", url); };
  const retry = act.retry;

  // Drawer: Escape closes, focus moves in on open, Tab stays inside, focus returns to the trigger on close (A9).
  const drawerRef = useRef(null);
  const confirmRef = useRef(null);
  const modelOptionFocusReturn = useRef(false);
  const returnFocus = useRef(null);
  const dOpen = !!v.dr;
  useEffect(() => {
    if (!dOpen) return;
    returnFocus.current = document.activeElement;
    const first = drawerRef.current?.querySelector('input[role="combobox"], input, select, button, [href]');
    first?.focus();
    const onKey = (e) => {
      if (confirmRef.current) return;
      if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }
      if (e.key !== "Tab" || !drawerRef.current) return;
      const items = [...drawerRef.current.querySelectorAll("button:not([disabled]), select, input, a[href]")];
      if (!items.length) return;
      const a = items[0], b = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const back = returnFocus.current;
      if (back && typeof back.focus === "function" && document.contains(back)) back.focus();
    };
  }, [dOpen, closeDrawer]);
  const confirmOpen = !!v.cm;
  useEffect(() => {
    if (!confirmOpen || !confirmRef.current) return;
    const dialog = confirmRef.current;
    const first = dialog.querySelector("button");
    first?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); setCf(false); return; }
      if (e.key !== "Tab") return;
      const items = [...dialog.querySelectorAll("button:not([disabled]), input, select, a[href]")];
      if (!items.length) return;
      const firstItem = items[0], lastItem = items.at(-1);
      if (e.shiftKey && document.activeElement === firstItem) { e.preventDefault(); lastItem.focus(); }
      else if (!e.shiftKey && document.activeElement === lastItem) { e.preventDefault(); firstItem.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmOpen, setCf]);

  return (
    <div data-r9={theme}>
      <div className="r9-agent-shell" style={{ maxWidth: 1240, margin: "0 auto", padding: "0 24px 40px", boxSizing: "border-box" }}>
        {/* shared page header */}
        <div className="r9-page-header">
          <div className="r9-header-main">
            <PageHeader title="Agents" subtitle="Live and past agent sessions, by role and model." icon="smart_toy" />
            <span title="Which agent runs each request. Role = the combo that routed it: main, implementer, reviewer, thinker, scout, background (Claude Code Haiku jobs), or direct (single model, no combo)." style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, padding: "0 9px", height: 22, borderRadius: 11, background: v.status.bg, color: v.status.c, whiteSpace: "nowrap" }}>
              {v.tabs[0].dot && <span style={v.tabs[0].dot} />}{v.status.text}
            </span>
          </div>
          <div className="r9-header-controls">
            <div ref={tabsScrollRef} className={`r9-scroll-x r9-header-tabs-scroll${tabsAtEnd ? " at-end" : ""}`}><div className="r9-tablist" role="tablist" aria-label="Agent views" onKeyDown={(e) => {
              if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
              const buttons = [...e.currentTarget.querySelectorAll('[role="tab"]')];
              const index = buttons.indexOf(document.activeElement);
              if (index < 0) return;
              e.preventDefault(); const next = buttons[(index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]; next?.focus(); next?.click();
            }}>
              {v.tabs.map((t) => <button key={t.label} onClick={t.on} style={t.style} role="tab" aria-selected={ui.tab === t.label.toLowerCase()} aria-label={t.count ? t.label + " " + t.count : t.label}>{t.dot && <span style={t.dot} />}{t.label}{t.count && <span style={{ fontSize: 11, color: "var(--tx2)", marginLeft: 8 }}>{t.count}</span>}</button>)}
            </div></div>
            {ui.tab === "live" ? (
              <button onClick={v.togglePause} aria-label={v.paused ? "Resume live feed" : "Pause live feed"} style={{ display: "flex", alignItems: "center", gap: 7, border: 0, background: "transparent", padding: 0, font: "inherit", fontSize: 12, color: v.fresh.c, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                <span style={v.fresh.dot} />{v.fresh.text}<span className="r9-hacc" style={{ fontFamily: "'Material Symbols Outlined'", fontSize: 15 }}>{v.fresh.icon}</span>{v.fresh.btn}
              </button>
            ) : <RangeBar preset={v.preset} customLabel={v.customLabel} onChange={onRange} />}
          </div>
          <div style={{ fontSize: 11, color: "var(--tx2)", display: "flex", alignItems: "center", gap: 4 }}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>schedule</span>Times in IST (UTC+5:30) · Agent telemetry logging began Nov 9</div>
        </div>

        {isLoading && <AgentsSkeleton v={v} />}
        {isError && (
          <div style={{ background: "var(--card)", border: "1px solid var(--red)", borderRadius: 12, padding: "28px 24px", textAlign: "center", opacity: v.v.dim }}>
            <span className="material-symbols-outlined" style={{ fontSize: 30, color: "var(--red)" }}>cloud_off</span>
            <p style={{ fontSize: 14, fontWeight: 600 }}>{v.v.errTitle}</p>
            <p style={{ fontSize: 12.5, color: "var(--tx2)" }}>{v.v.errBody}</p>
            <button onClick={retry} style={{ marginTop: 8, height: 30, padding: "0 14px", borderRadius: 8, border: 0, background: "var(--acc)", color: "#fff", font: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Retry</button>
          </div>
        )}
        {ready && v.v.empty && (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: "48px 24px", textAlign: "center" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 34, color: "var(--tx3)" }}>{v.v.emptyIcon}</span>
            <p style={{ fontSize: 14, fontWeight: 600, margin: "10px 0 4px" }}>{v.v.emptyTitle}</p>
            <p style={{ fontSize: 12.5, color: "var(--tx2)", margin: "0 0 12px" }}>{v.v.emptyBody}</p>
            <button onClick={v.v.emptyGo} style={{ height: 30, padding: "0 14px", borderRadius: 8, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{v.v.emptyBtn}</button>
          </div>
        )}
        {ready && !v.v.empty && v.v.stale && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--amber)", background: "var(--amberbg)", border: "1px solid var(--amber)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>{v.v.staleText}
          </div>
        )}
        {ready && !v.v.empty && ui.tab === "live" && <LiveTab v={v} />}
        {ready && !v.v.empty && ui.tab === "sessions" && <SessionsTab v={v} ui={ui} moreBusy={moreBusy} />}
        {ready && !v.v.empty && ui.tab === "roles" && <RolesTab v={v} />}
        {ready && !v.v.empty && ui.tab === "tools" && <ToolsTab v={v} error={toolsError} loading={!tools && !toolsError} />}

        {v.dr && (
          <div role="dialog" aria-modal="true" aria-labelledby="r9-drawer-title" onClick={v.closeDrawer} style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.32)", display: "flex", justifyContent: "flex-end" }}>
            <div ref={drawerRef} onClick={(e) => e.stopPropagation()} style={{ width: ui.drawerMode === "details" ? v.dd?.w || v.dr.w : v.dr.w, maxWidth: "100vw", height: "100%", overflowY: "auto", background: "var(--card)", borderLeft: "1px solid var(--line)", boxShadow: "var(--shadow)", padding: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ position: "sticky", top: 0, zIndex: 2, minHeight: 56, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 16px", background: "var(--card)", borderBottom: "1px solid var(--line)" }}>
                <div>
                  <div id="r9-drawer-title" style={{ fontSize: 14, fontWeight: 600 }}>{ui.drawerMode === "details" ? "Session details" : "Change routing"} · {v.dr.sid}</div>
                  <div style={{ fontSize: 11, color: "var(--tx2)" }}>{v.dr.client} · started {v.dr.started}</div>
                </div>
                <button onClick={v.closeDrawer} aria-label="Close" style={{ border: 0, background: "var(--seg)", borderRadius: 7, width: 28, height: 28, cursor: "pointer", fontFamily: "'Material Symbols Outlined'", fontSize: 18, color: "var(--tx2)" }}>close</button>
              </div>
              {ui.drawerMode === "details" ? <DetailsDrawer data={v.dd} onRoute={() => v.dd?.route()} onClose={v.closeDrawer} /> : <div onClickCapture={(e) => { if (!e.target.closest(".r9-model-picker")) v.dr.rows.forEach((row) => row.popup && row.onOpen(false)); }} style={{ padding: "0 16px 16px", overflowY: "auto", flex: 1 }}>
              {v.dr.conflict && <div role="alert" style={{ margin: "12px 0", padding: 12, borderRadius: 8, background: "var(--redbg)", color: "var(--red)", fontSize: 12.5 }}><div><span className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: "middle", marginRight: 6 }}>sync_problem</span>Routing changed while this drawer was open. {v.dr.conflict.role} now uses {v.dr.conflict.currentModel}. Review and apply again.</div><button onClick={v.dr.reload} style={{ marginTop: 8, height: 28, border: "1px solid var(--line2)", borderRadius: 6, background: "var(--card)", color: "var(--tx)", cursor: "pointer" }}>Reload routing</button></div>}
              {v.dr.rows.map((r) => (
                <div key={r.role} style={r.rowStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={r.chip}>{r.role}</span>
                    <span style={{ fontSize: 12, color: "var(--tx2)" }}>now: <b>{r.cur}</b></span>
                  {r.status && <span style={r.statusStyle}>{r.status}</span>}
                  {r.canRevert && <button onClick={r.revert} style={{ marginLeft: "auto", height: 26, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Revert</button>}
                  </div>
                  {r.locked ? <p style={{ margin: 0, fontSize: 12, color: "var(--tx2)" }}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>lock</span> {r.lockText}</p> : <>
                  {r.dirty && <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--tx2)" }}><s>{r.from}</s> → <b style={{ color: "var(--tx)" }}>{r.to}</b></div>}
                  <div className="r9-model-picker">
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="r9-caps">MODEL</span><input role="combobox" aria-expanded={r.popup} aria-controls={`models-${r.role}`} aria-autocomplete="list" value={r.query} onFocus={(e) => { if (modelOptionFocusReturn.current || e.relatedTarget?.matches('[role="option"]')) { modelOptionFocusReturn.current = false; return; } r.onOpen(true); }} onChange={r.onQ} onKeyDown={(e) => {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); r.onOpen(true); const opts = [...e.currentTarget.parentElement.parentElement.querySelectorAll('[role="option"]')]; (e.key === "ArrowDown" ? opts[0] : opts.at(-1))?.focus(); }
                      if (e.key === "Home" || e.key === "End") { e.preventDefault(); r.onOpen(true); const opts = [...e.currentTarget.parentElement.parentElement.querySelectorAll('[role="option"]')]; (e.key === "Home" ? opts[0] : opts.at(-1))?.focus(); }
                      if (e.key === "Escape" && r.popup) { e.preventDefault(); e.stopPropagation(); r.onOpen(false); }
                      if (e.key === "Enter") { e.preventDefault(); const first = r.otherGroups.flatMap((g) => g.opts)[0]; if (first) r.onChoose(first.v); }
                    }} placeholder="Search models" aria-label={`Search models for ${r.role}`} style={{ height: 32, width: "100%", boxSizing: "border-box", padding: "0 10px", borderRadius: 8, border: "1px solid var(--line2)", background: "var(--bg)", color: "var(--tx)", fontFamily: "var(--mono)", fontSize: 12.5 }} /></label>
                    {r.popup && <div id={`models-${r.role}`} role="listbox" className="r9-model-popup">
                      {r.otherGroups.length ? r.otherGroups.map((g) => <div key={g.label}><div className="r9-model-group">{g.label}</div>{g.opts.map((o) => <button key={o.v} type="button" role="option" aria-selected={r.other === o.v || (!r.other && o.current)} onClick={() => r.onChoose(o.v)} onKeyDown={(e) => {
                        const opts = [...e.currentTarget.closest('[role="listbox"]').querySelectorAll('[role="option"]')], i = opts.indexOf(e.currentTarget);
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
                        if (e.key === "Home") { e.preventDefault(); opts[0]?.focus(); }
                        if (e.key === "End") { e.preventDefault(); opts.at(-1)?.focus(); }
                        if (e.key === "Enter") { e.preventDefault(); r.onChoose(o.v); }
                        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); modelOptionFocusReturn.current = true; r.onOpen(false); e.currentTarget.closest(".r9-model-picker")?.querySelector('[role="combobox"]')?.focus(); }
                      }} style={{ height: 32, width: "100%", display: "flex", alignItems: "center", gap: 8, border: 0, background: "transparent", color: "var(--tx)", padding: "0 10px", textAlign: "left", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 12.5 }}><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>{o.current && <small>current</small>}{o.expensive && <small style={{ color: "var(--amber)" }}>$$$</small>}</button>)}</div>) : <div style={{ padding: 12, color: "var(--tx2)", fontSize: 12 }}>No chat model matches “{r.otherQ}”.</div>}
                    </div>}
                    {r.role === "" && null}{v.dr.isCodex && <div style={{ fontSize: 11, color: "var(--tx2)" }}>Codex sessions can only use OpenAI models.</div>}
                  </div>
                  {r.warn && <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--amberbg)", fontSize: 12, color: "var(--amber)" }}><span className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: "middle", marginRight: 4 }}>warning</span>{r.warn}</div>}
                  <div className="r9-routing-controls"><div><div className="r9-caps" style={{ marginBottom: 4 }}>MODE</div><div role="group" aria-label={r.modeAria} style={{ display: "flex", gap: 2, padding: 2, borderRadius: 8, background: "var(--seg)" }}>{r.modes.map((m) => <button key={m.label} onClick={m.on} aria-pressed={m.on2} title={m.tip} style={m.style}>{m.label}</button>)}</div></div><label style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="r9-caps">UNTIL</span><select value={r.expiry} onChange={r.onExp} style={{ height: 28, border: "1px solid var(--line2)", borderRadius: 7, background: "var(--bg)", color: "var(--tx)", font: "inherit", fontSize: 12.5 }}><option value="Session end">Session end</option><option value="1h">1 hour</option><option value="2h">2 hours</option></select></label></div>
                  {r.strict && <span style={{ fontSize: 11.5, color: "var(--tx2)" }}>No fallback. If this model fails, the request fails visibly.</span>}
                </>}
                </div>
              ))}
            <div style={{ padding: "10px 12px", borderRadius: 8, background: "var(--seg)", fontSize: 12, color: "var(--tx2)" }}>Applies from the next request only. Requests in flight keep their model.{v.dr.isCodex && <span> Codex sessions can only use OpenAI models.</span>} <a href="/dashboard/combos">Edit combo members for everyone →</a></div>
            </div>}
            {ui.drawerMode === "routing" && <div style={{ position: "sticky", bottom: 0, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, minHeight: 56, padding: "0 16px", borderTop: "1px solid var(--line)", background: "var(--card)" }}><span style={{ marginRight: "auto", fontSize: 12, color: "var(--tx2)" }}>{v.dr.conflict ? "Reload routing to continue" : v.dr.changeText}</span><button onClick={v.closeDrawer} style={{ height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12.5, cursor: "pointer" }}>Cancel</button><button onClick={v.dr.apply} disabled={v.dr.noChanges || !!v.dr.conflict} style={{ ...v.dr.applyStyle, height: 32, opacity: v.dr.noChanges || v.dr.conflict ? 0.45 : 1 }}>Apply</button></div>}
            </div>
          </div>
        )}
        {v.cm && <>
          <div onClick={v.cancelCf} style={{ position: "fixed", inset: 0, zIndex: 95, background: "rgba(20,10,5,.28)" }} />
          <div ref={confirmRef} role="dialog" aria-modal="true" aria-label={v.cm.title} style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 96, width: 460, maxWidth: "calc(100vw - 32px)", background: "var(--card)", border: "1px solid var(--line2)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 24, display: "flex", flexDirection: "column", gap: 14, boxSizing: "border-box" }}>
            <strong>{v.cm.title}</strong>{v.cm.lines.map((line) => <div key={line.role} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 12.5 }}><span style={line.chip}>{line.role}</span><span>{line.from}</span> → <b>{line.to}</b><span style={{ color: "var(--tx2)" }}>· {line.mode} · until {line.exp}</span></div>)}
            <span style={{ fontSize: 12.5, color: "var(--tx2)" }}>Applies from the next request. Requests in flight keep their model.</span><div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><button onClick={v.cancelCf}>Cancel</button><button onClick={v.doCf}>Apply</button></div>
          </div>
        </>}
        {v.toast && <div role="status" style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 99, display: "flex", alignItems: "center", gap: 12, minHeight: 40, padding: "0 8px 0 16px", borderRadius: 8, background: "var(--tx)", color: "var(--bg)", fontSize: 12.5, boxShadow: "var(--shadow)", maxWidth: "calc(100vw - 32px)" }}><span>{v.toast}</span>{retryRouting && <button onClick={() => { const retry = retryRouting; setRetryRouting(null); applyOverrides(retry.sid, retry.changes); }} style={{ border: 0, background: "transparent", color: "var(--bg)", font: "inherit", fontWeight: 600, cursor: "pointer" }}>Retry</button>}<button onClick={() => { setRetryRouting(null); v.closeToast(); }} aria-label="Dismiss">×</button></div>}
      </div>
    </div>
  );
}

function AgentsSkeleton({ v }) {
  return (
    <div aria-hidden="true">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(150px,1fr))", gap: 10, overflowX: "auto", marginBottom: 14 }}>
        {v.skel6.map((k, i) => <div key={i} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}><div style={{ width: k.w, height: 10, borderRadius: 5, background: "var(--seg)" }} /><div style={{ width: k.wb, height: 16, borderRadius: 5, background: "var(--seg)", marginTop: 8 }} /></div>)}
      </div>
      <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: 16 }}>
        {v.skel8.map((k, i) => <div key={i} style={{ display: "flex", gap: 10, paddingLeft: k.p, paddingTop: 6 }}><div style={{ width: k.w, height: 12, borderRadius: 6, background: "var(--seg)" }} /></div>)}
      </div>
    </div>
  );
}

function LiveTab({ v }) {
  if (!v.v.live) return null;
  if (v.liveWide) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="r9-kpis" style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(0,1fr))", gap: 16 }}>
          {v.live.kpis.map((k) => <Kpi key={k.label} k={k} />)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,360px),1fr))", gap: 16, alignItems: "start" }}>
          {v.live.cards.map((c) => <LiveCard key={c.id} c={c} />)}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="r9-kpis" style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(0,1fr))", gap: 16 }}>
        {v.live.kpis.map((k) => <Kpi key={k.label} k={k} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>{v.live.cards.map((c) => <LiveCard key={c.id} c={c} narrow />)}</div>
    </div>
  );
}

function Kpi({ k, mini }) {
  return (
    <div title={k.tip} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 12, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", color: "var(--tx2)", whiteSpace: "nowrap" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: k.dot, marginRight: 5 }} />{k.label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: k.c, fontVariantNumeric: "tabular-nums" }}>{["Not tracked yet", "No samples"].includes(k.value) ? <span className="r9-nodata" title={k.tip} aria-label={k.tip}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>{k.value}</span> : k.value}</div>
      <div style={{ fontSize: 11, color: "var(--tx2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={k.sub}>{k.sub}</div>
    </div>
  );
}

function LiveCard({ c, narrow }) {
  return (
    <article style={{ ...c.wrap, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "12px 12px 8px" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, fontFamily: "var(--mono)" }}><span style={{ ...c.activityDot, width: 8, height: 8, borderRadius: "50%" }} title={c.inFlight == null ? "Session activity" : `${c.inFlight} requests in flight`} />{c.id}</span>
        <span style={{ fontSize: 11.5, color: "var(--tx2)" }}>{c.client} · since {c.started}</span>
        {c.isChild && <span title={c.parentTip || ""} style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 5, background: "var(--seg)", color: "var(--tx2)" }}>inferred child</span>}
        {c.bgNote && <span title="Claude Code Haiku jobs: titles, summaries, WebSearch. Not subagents." style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 5, background: "var(--amberbg)", color: "var(--chipthink)" }}>+background</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 0 }}>
        {c.rows.map((r) => (
          <div key={r.role} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 12px", borderTop: "1px solid var(--line)", opacity: r.op, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={r.chip}>{r.role}</span>
              <span title={r.model} style={{ minWidth: 0, flex: "1 1 180px", overflowWrap: "anywhere", fontSize: 12.5, fontFamily: "var(--mono)", color: "var(--tx)" }}><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: r.mc, marginRight: 5 }} />{r.model}</span>
              {r.tag && <span style={r.tagStyle}>{r.tag}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--tx3)", paddingLeft: 2 }}>
              <span>{r.prov}</span>
              <span aria-label={`${r.role} ${r.state.aria}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 20, padding: "0 8px 0 6px", borderRadius: 10, background: r.state.bg, color: r.state.color, fontSize: 11, fontWeight: 600 }}><span style={r.dot} />{r.state.label}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{r.rpm}/m{r.tps && ` · ${r.tps}`}{r.p50 && ` · ${r.p50}`}</span>
              {r.succ && <span style={{ color: r.succC, fontVariantNumeric: "tabular-nums" }}>{r.succ}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="r9-card-footer" style={{ display: "flex", gap: 8, marginTop: "auto", borderTop: "1px solid var(--line)", padding: "8px 12px", justifyContent: "flex-end" }}>
        <button onClick={c.details} style={{ height: 28, padding: "0 12px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}><span className="material-symbols-outlined" style={{ fontSize: 15, verticalAlign: "middle", marginRight: 4 }}>info</span>Details</button>
        <button onClick={c.timeline} style={{ height: 28, padding: "0 12px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx2)", font: "inherit", fontSize: 12, cursor: "pointer" }}><span className="material-symbols-outlined" style={{ fontSize: 15, verticalAlign: "middle", marginRight: 4 }}>timeline</span>Timeline</button>
        <button onClick={c.route} style={{ height: 28, padding: "0 12px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--acc)", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}><span className="material-symbols-outlined" style={{ fontSize: 15, verticalAlign: "middle", marginRight: 4 }}>alt_route</span>Change routing</button>
      </div>
    </article>
  );
}

function SessionsTab({ v, ui, moreBusy }) {
  const detailRef = useRef(null);
  if (!v.v.sess) return null;
  const t = v.tree, g = v.g, sm = v.sm;
  return (
    <div>
      {v.v.partial && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--tx2)", background: "var(--seg)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>history</span>{v.v.partialText}
        </div>
      )}
      <div className="r9-sessions-layout" style={{ display: "grid", gridTemplateColumns: v.lay.tf === "1fr" ? "minmax(0,1fr)" : `${v.lay.tf} minmax(0,1fr)`, gap: 16, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)" }}>
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="r9-client-filter" role="group" aria-label="Filter by client">{t.clientOpts.map((o) => <button type="button" key={o.v} aria-pressed={t.fClient === o.v} onClick={() => t.onClient({ target: { value: o.v } })}>{o.label}</button>)}</div>
              <select value={t.fRole} onChange={t.onRole} aria-label="Filter by role or direct model" style={{ font: "inherit", fontSize: 12.5, height: 28, borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)" }}><option value="">All roles and models</option>{t.roleGroups.map((g) => <optgroup key={g.label} label={g.label}>{g.opts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</optgroup>)}</select>
              <input value={t.q} onChange={t.onQ} placeholder="Search session ID" aria-label="Search session ID" style={{ height: 28, minWidth: 0, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12.5 }} />
              <div style={{ fontSize: 11, color: "var(--tx2)" }}>{t.count}</div>
            </div>
            <div role="listbox" aria-label="Sessions" style={{ borderTop: "1px solid var(--line)", maxHeight: 560, overflowY: "auto", overflowX: "hidden" }}>
              {t.none && <p style={{ padding: "24px 16px", fontSize: 12.5, color: "var(--tx2)", textAlign: "center" }}>{t.noneText}{t.filtered && <> <button onClick={t.clear} style={{ border: 0, background: "none", color: "var(--acc)", cursor: "pointer", font: "inherit" }}>Clear filters</button></>}</p>}
              {t.rows.map((r, i) => (
                <div key={(r.isSess ? "s" : r.isRole ? "r" : "m") + i + r.label} className="r9-session-row" data-child={r.isKid ? "true" : undefined} data-guessed={r.inferred ? "true" : undefined} tabIndex={0} role="option" aria-selected={r.isSess && r.sid === ui.sel} aria-expanded={r.isSess ? r.exp : undefined} onClick={r.on} onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); r.on(); if (window.innerWidth <= 600) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }
                  if (r.isSess && r.hasChildren && e.key === "ArrowRight" && !r.exp) { e.preventDefault(); r.toggle(); }
                  if (r.isSess && r.hasChildren && e.key === "ArrowLeft" && r.exp) { e.preventDefault(); r.toggle(); }
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const opts = [...e.currentTarget.parentElement.querySelectorAll('[role="option"]')]; const next = opts[Math.max(0, Math.min(opts.length - 1, opts.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)))]; next?.focus(); next?.click(); }
                }} style={{ ...r.style, minHeight: 36, gridTemplateColumns: "16px minmax(0,1fr) 8px auto", padding: `6px 12px 6px ${12 + (r.isKid ? 16 : 0)}px`, boxShadow: r.sid === ui.sel ? "inset 2px 0 0 var(--acc)" : "none", position: "relative" }}>
                  <span style={{ gridColumn: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {r.isSess && <button type="button" aria-label={r.exp ? "Collapse session" : "Expand session"} aria-expanded={r.exp} onClick={(e) => { e.stopPropagation(); r.toggle(); }} style={{ padding: 0, border: 0, background: "transparent", color: "var(--tx3)", fontFamily: "'Material Symbols Outlined'", fontSize: 16, cursor: "pointer" }}>{r.chev}</button>}
                    {r.isKid && <span className="material-symbols-outlined" style={{ fontSize: 14, color: "var(--tx3)" }} title="Delegated child (T3). Link inferred.">subdirectory_arrow_right</span>}
                  </span>
                  <span style={{ gridColumn: 2, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.isRole && <span style={r.chip}>{r.label}</span>}
                    {r.isModel && <span><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: r.mc, marginRight: 5 }} />{r.label}</span>}
                    {r.isSess && <><span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 12.5 }}>{r.label}{r.inferred && <span className="r9-likely-child">likely child</span>}</span><span style={{ display: "block", color: "var(--tx2)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</span></>}
                  </span>
                  <span style={{ gridColumn: 3, display: "flex", justifyContent: "center" }}>
                    {r.live && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)" }} title="Live now" />}
                  </span>
                  <span style={{ gridColumn: 4, justifySelf: "end", display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--tx2)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{r.req} · {r.tok} · <span style={{ color: "var(--violet)" }}>{r.val}</span>{+r.err > 0 && <span title={`${r.err} failed ${+r.err === 1 ? "request" : "requests"}`} style={{ color: "var(--red)" }}> · {r.err} ✕</span>}{r.isSess && <button data-session-details type="button" aria-label={`Details for ${r.label}`} onClick={(e) => { e.stopPropagation(); r.details(); }} style={{ height: 24, padding: "0 5px", border: "1px solid var(--line2)", borderRadius: 5, background: "var(--card)", color: "var(--tx2)", font: "inherit", cursor: "pointer" }}>Details</button>}</span>
                </div>
              ))}
            </div>
            {t.canMore && (
              <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
                <button onClick={t.onMore} disabled={moreBusy} style={{ height: 36, width: "100%", padding: "0 12px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12, fontWeight: 600, cursor: moreBusy ? "default" : "pointer", whiteSpace: "nowrap" }}>{moreBusy ? <><span className="material-symbols-outlined" style={{ fontSize: 14, verticalAlign: "middle" }}>progress_activity</span> Loading…</> : `Load 100 more · showing ${t.loaded} of ${t.total}`}</button>
              </div>
            )}
          </div>
        </div>
        <div ref={detailRef} style={{ minWidth: 0 }}>
          {g && sm ? <Gantt v={v} ui={ui} /> : (
            <div style={{ background: "var(--card)", border: "1px dashed var(--line2)", borderRadius: 12, padding: "40px 20px", textAlign: "center", color: "var(--tx2)" }}><span className="material-symbols-outlined" style={{ fontSize: 22, color: "var(--tx3)" }}>left_click</span><div style={{ marginTop: 6, fontSize: 14, fontWeight: 600 }}>{v.noSelText.includes("hidden") ? "Select a session" : v.noSelText}</div>{v.noSelText.includes("hidden") && <div style={{ marginTop: 4, fontSize: 12, color: "var(--tx2)" }}>{v.noSelText}</div>}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailsDrawer({ data, onRoute, onClose }) {
  if (!data?.hasData) return <div aria-busy="true" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>{Array.from({ length: 5 }, (_, i) => <section key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}><div style={{ width: 92, height: 11, borderRadius: 6, background: "var(--seg)" }} /><div style={{ height: i === 0 ? 24 : 56, borderRadius: 8, background: "var(--seg)" }} /></section>)}</div>;
  const factValue = (label, value) => value === "Not recorded" ? <span className="r9-nodata" title={`${label} is not included in the session data.`} aria-label={`${label} is not recorded`}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>Not recorded</span> : value;
  return <>
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", flex: 1 }}>
      <section>
        <div style={{ fontSize: 20, lineHeight: 1.25, fontWeight: 700, overflowWrap: "anywhere" }}>{data.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, color: "var(--tx2)", fontFamily: "var(--mono)", fontSize: 12 }}>{data.sid}<button onClick={() => data.copy(data.sid.slice(2))} aria-label="Copy session ID" style={{ width: 28, height: 28, border: "1px solid var(--line2)", borderRadius: 6, background: "var(--card)", color: "var(--tx2)", cursor: "pointer", fontFamily: "'Material Symbols Outlined'" }}>content_copy</button></div>
      </section>
      <section><h3 className="r9-drawer-section-title">Facts</h3><dl className="r9-facts">{data.facts.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{label === "Parent" && data.parentSession ? <button onClick={data.openParent} style={{ border: 0, background: "none", padding: 0, color: "var(--acc)", font: "12.5px var(--mono)", cursor: "pointer" }}>{value}</button> : factValue(label, value)}</dd></React.Fragment>)}</dl></section>
      <section><h3 className="r9-drawer-section-title">Totals</h3><div className="r9-details-kpis">{data.stats.map(([label, value, sub]) => <div key={label}><div className="r9-caps">{label}</div><strong style={{ color: label === "Value" ? "var(--violet)" : "var(--tx)" }}>{value === "Not recorded" ? <span className="r9-nodata" title={`${label} is not available in the session data.`} aria-label={`${label} is not recorded`}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>Not recorded</span> : value}</strong>{sub && <small>{sub}</small>}</div>)}</div></section>
      <section><h3 className="r9-drawer-section-title">Roles and models{data.roleSampled ? " · sampled" : ""}</h3>{data.roleSampled && <small style={{ display: "block", color: "var(--tx2)", marginBottom: 6 }}>From the latest 2,000 requests.</small>}{data.roles.length ? data.roles.map((r) => <div className="r9-detail-role" key={`${r.role}-${r.model}`}><span style={r.chip}>{r.role}</span><span className="r9-detail-model" title={r.model}>{r.model}</span><span>{r.requests} · {r.tokens}</span><span className="r9-share-track"><i style={{ width: `${r.share}%`, background: r.color }} /></span><b style={{ color: "var(--violet)" }}>{r.value}</b></div>) : <span className="r9-nodata" title="No role totals are available."><span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>Not recorded</span>}</section>
      <section><h3 className="r9-drawer-section-title">Tools</h3>{data.tools.length ? data.tools.slice(0, 8).map((tool) => <div className="r9-tool-row" key={tool.name}><code>{tool.name}</code><span>{tool.calls}{tool.errors > 0 && <b title={`${tool.errors} tool errors`} style={{ color: "var(--red)", marginLeft: 8 }}>{tool.errors} ✕</b>}</span></div>) : <span className="r9-nodata" title="Tool calls are not included in this session response."><span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>Not recorded</span>}</section>
    </div>
    <div style={{ position: "sticky", bottom: 0, minHeight: 56, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "0 16px", borderTop: "1px solid var(--line)", background: "var(--card)" }}><button onClick={onRoute} style={{ height: 32, border: 0, borderRadius: 7, padding: "0 12px", background: "var(--acc)", color: "#fff", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Change routing</button><button onClick={onClose} style={{ height: 32, border: "1px solid var(--line2)", borderRadius: 7, padding: "0 12px", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Close</button></div>
  </>;
}

function Gantt({ v, ui }) {
  const g = v.g, sm = v.sm;
  const popoverRef = useRef(null), triggerRef = useRef(null);
  useEffect(() => {
    if (!g.pick) return;
    const close = () => { v.closePick(); triggerRef.current?.focus(); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    const down = (e) => { if (!popoverRef.current?.contains(e.target)) close(); };
    document.addEventListener("keydown", key); document.addEventListener("mousedown", down);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", down); };
  }, [g.pick, v]);
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{sm.id}</span>
        <span style={{ fontSize: 12, color: "var(--tx2)" }}>{sm.client} · {sm.when}</span>
        {sm.live && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)" }} title="Live now" />}
        <span style={{ marginLeft: "auto" }} />
      </div>
      <div className="r9-session-summary">
        {sm.stats.map((s) => <div key={s.l} title={s.s || ""}><span>{s.l}</span><b style={{ color: s.c }}>{s.v}</b>{s.s && <small>{s.s}</small>}{s.l === "Value" && <small>estimate</small>}</div>)}
        <button onClick={sm.details} style={{ height: 28, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Details</button>
        <button onClick={sm.route} style={{ height: 28, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Change routing</button>
      </div>
      <div className="r9-timeline-toolbar"><span>{g.window}</span><span className="r9-timeline-zooms"><button onClick={g.prev} disabled={g.noPrev} aria-label="Earlier" aria-disabled={g.noPrev} style={{ ...g.prevStyle, width: 28, height: 28, border: 0 }}>chevron_left</button>{g.zooms.map((z) => <button key={z.label} onClick={z.on} style={z.style}>{z.label}</button>)}<button onClick={g.next} disabled={g.noNext} aria-label="Later" aria-disabled={g.noNext} style={{ ...g.nextStyle, width: 28, height: 28, border: 0 }}>chevron_right</button></span></div>
      <div onMouseLeave={v.unhover} style={{ position: "relative" }}>
        <div style={{ display: "flex", position: "relative", height: 18 }}>
          {g.ticks.map((t, i) => <span key={i} style={{ position: "absolute", left: t.l, fontSize: 10.5, color: "var(--tx3)", transform: "translateX(-50%)", fontVariantNumeric: "tabular-nums" }}>{t.label}</span>)}
        </div>
        {g.gaps.map((gp, i) => <div key={i} title={"Idle gap: " + gp.label} style={{ position: "absolute", left: gp.l, width: gp.w, top: 24, bottom: 0, background: "repeating-linear-gradient(135deg,transparent 0 4px,var(--line) 4px 5px)", borderRadius: 4, pointerEvents: "none" }} />)}
        {g.now && <div style={{ position: "absolute", left: g.nowL, top: 20, bottom: 0, width: 1, background: "var(--green)" }} title="now" />}
        {g.lanes.map((l, li) => (
          <div key={li} className="r9-timeline-lane" role="group" aria-label={`${l.role} requests`} title={l.tip} style={{ display: "flex", alignItems: "center", gap: 8, height: 39, opacity: l.op }}>
            <button className="r9-timeline-role-label" onClick={l.focus} style={{ width: 120, flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, border: 0, background: "transparent", padding: 0, font: "inherit", cursor: "pointer", textAlign: "left" }}>
              <span style={l.chip}>{l.role}</span>
              <span style={{ fontSize: 10.5, color: "var(--tx3)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.model}</span>
            </button>
            <div style={{ position: "relative", flex: 1, height: 39 }}>
              {l.bars.map((b, ri) => <button key={ri} type="button" aria-label={b.aria} title={b.aria} onMouseEnter={b.hover} onFocus={b.hover} onClick={(e) => { triggerRef.current = e.currentTarget; b.pick(); }} onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
                e.preventDefault(); const lane = e.currentTarget.closest(".r9-timeline-lane");
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") { const buttons = [...lane.querySelectorAll("button[aria-label]")]; buttons[Math.max(0, Math.min(buttons.length - 1, buttons.indexOf(e.currentTarget) + (e.key === "ArrowRight" ? 1 : -1)))]?.focus(); }
                else { const lanes = [...lane.parentElement.querySelectorAll(".r9-timeline-lane")]; const next = lanes[Math.max(0, Math.min(lanes.length - 1, lanes.indexOf(lane) + (e.key === "ArrowDown" ? 1 : -1)))]; next?.querySelector("button[aria-label]")?.focus(); }
              }} style={b.style} />)}
            </div>
          </div>
        ))}
        {g.hov && (
          <div style={{ position: "absolute", ...g.hov, zIndex: 30, width: 260, background: "var(--card)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 12px 32px rgba(40,20,10,.16)", padding: "10px 12px", pointerEvents: "none" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>{g.hov.model}</div>
            <div style={{ fontSize: 11.5, color: "var(--tx2)", marginBottom: 6 }}>{g.hov.prov} · <span style={g.hov.stStyle}>{g.hov.status}</span></div>
            {g.hov.facts.map((f) => <div key={f.l} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}><span style={{ color: "var(--tx2)" }}>{f.l}</span><b style={{ color: f.c }}>{f.v === "Not logged before Nov 9" ? <span className="r9-nodata" title="Latency was not logged before Nov 9.">{f.v}</span> : f.v}</b></div>)}
          </div>
        )}
        {g.pick && (
          <div ref={popoverRef} role="dialog" aria-label={"Request " + g.pick.rid} style={{ position: "absolute", ...g.pick, zIndex: 31, width: 280, maxWidth: "calc(100% - 16px)", boxSizing: "border-box", background: "var(--card)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 12px 32px rgba(40,20,10,.16)", padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{g.pick.model}</span>
              <span style={g.pick.stStyle}>{g.pick.status}</span>
              <button onClick={v.closePick} aria-label="Close request details" style={{ marginLeft: "auto", border: 0, background: "var(--seg)", borderRadius: 6, width: 24, height: 24, cursor: "pointer", fontFamily: "'Material Symbols Outlined'", fontSize: 15, color: "var(--tx2)" }}>close</button>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--tx3)", margin: "2px 0 6px" }}>{g.pick.rid}</div>
            {g.pick.facts.map((f) => <div key={f.l} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}><span style={{ color: "var(--tx2)" }}>{f.l}</span><b style={{ color: f.c, fontFamily: f.ff }}>{["Not logged before Nov 9", "Not recorded"].includes(f.v) ? <span className="r9-nodata" title="This value is not available in the session data.">{f.v}</span> : f.v}</b></div>)}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        {g.legend.map((l) => <span key={l.m} title={l.m} style={{ fontSize: 11, color: "var(--tx2)" }}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: l.c, marginRight: 4 }} />{l.m}</span>)}
      </div>
      <div className="r9-request-list"><div className="r9-request-head"><span>Time</span><span>Role</span><span>Model</span><span>TTFT</span><span>Total</span><span>Tokens in/out</span><span>Value</span><span>Status</span></div>{g.requests.map((r, i) => <div className="r9-request-row" key={`${r.time}-${i}`}><span>{r.time}</span><span>{r.role}</span><code>{r.model}</code><span>{r.ttft === "Not recorded" ? <span className="r9-nodata" title="Latency was not logged before Nov 9.">Not logged before Nov 9</span> : r.ttft}</span><span>{r.total === "Not recorded" ? <span className="r9-nodata" title="Latency was not logged before Nov 9.">Not logged before Nov 9</span> : r.total}</span><span>{r.tokens}</span><span style={{ color: "var(--violet)" }}>{r.value}</span><span style={r.statusStyle}>{r.status}</span></div>)}</div>
      <p style={{ fontSize: 11, color: "var(--tx3)", margin: "8px 0 0" }}>{g.note}</p>
    </div>
  );
}

function RolesTab({ v }) {
  const r = v.ro;
  return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, fontWeight: 600, letterSpacing: ".06em", color: "var(--tx2)", marginBottom: 10 }}><span>SHARE OF WORK</span><span style={{ fontWeight: 400, letterSpacing: 0 }}>{r.totalRequests} requests · {r.sessionRequests} with a session</span></div>
        {r.share.map((s) => (
          <div key={s.label} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: "var(--tx2)" }}>{s.label}</span><b style={{ color: s.c }}>{s.total}</b>
            </div>
            <div role="img" aria-label={s.aria} style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: "var(--seg)" }}>
              {s.segs.map((g, i) => <span key={i} title={g.t} style={{ flex: `${g.f} 1 0`, minWidth: Number(g.f) > 0 && Number(g.f) < 5 ? 2 : 0, background: g.c, borderRight: "1px solid var(--card)" }} />)}
            </div>
          </div>
        ))}
        <div className="r9-role-legends">
          <div><div className="r9-caps">Roles</div>{r.legend.map((l) => <div key={l.role} className="r9-role-legend-row"><span className="r9-role-dot" style={{ background: l.c }} /><span style={l.chip}>{l.role}</span><span>{l.req} req · {l.tok} tok · {l.val} val</span></div>)}</div>
          <div><div className="r9-caps">Direct models</div>{r.legendDirect.map((l) => <div key={l.model} className="r9-role-legend-row"><span className="r9-role-dot" style={{ background: l.c }} /><code>{l.model}</code><span>{l.req} req · {l.tok} tok · {l.val} val</span></div>)}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(180px,1fr))", gap: 16 }} className="r9-role-kpis">
        {r.cards.map((c) => (
          <div key={c.label} title={c.tip} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".04em", color: "var(--tx3)" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: c.dot, marginRight: 5 }} />{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{c.value}</div>
            <div style={{ fontSize: 11, color: "var(--tx3)" }}>{c.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", fontSize: 11.5, fontWeight: 600, letterSpacing: ".05em", color: "var(--tx2)" }}>MODELS INSIDE EACH ROLE</div>
        <div className="r9-role-table-wrap" style={{ overflowX: "auto" }}>
          <table className="r9-role-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 11, color: "var(--tx3)" }}>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>Model</th><th style={{ padding: "8px 12px", fontWeight: 600 }}>Req</th>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>TPS</th><th style={{ padding: "8px 12px", fontWeight: 600 }}>TTFT</th>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>P50 / P95</th><th style={{ padding: "8px 12px", fontWeight: 600 }}>Success</th>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>$/req</th><th style={{ padding: "8px 12px", fontWeight: 600 }}>Samples</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((m, i) => m.head ? (
                <tr key={"h" + i} className="r9-role-group" style={{ background: "var(--seg)" }}>
                  <td colSpan={8} style={{ padding: "7px 12px" }}>{m.role === "direct" ? <strong style={{ fontSize: 11, letterSpacing: ".06em", color: "var(--tx2)" }}>DIRECT MODELS</strong> : <><span style={m.chip}>{m.role}</span> <span style={{ fontSize: 11, color: "var(--tx2)" }}>{m.desc}</span></>}</td>
                </tr>
              ) : (
                <tr key={"r" + i} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "7px 12px" }}><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: m.mc, marginRight: 5 }} /><span className="r9-role-model-name">{m.model}</span> <span className="r9-role-provider">{m.prov}</span>
                    {m.configError && <span className="r9-config-error"><b>Config error</b> <a href="/dashboard/combos">Fix in Combos</a></span>}
                    {m.fast && <span style={r.fastChip}><span className="material-symbols-outlined" style={{ fontSize: 12 }}>bolt</span>fastest</span>}
                    {m.rel && <span style={{ marginLeft: 4, ...r.relChip }}><span className="material-symbols-outlined" style={{ fontSize: 12 }}>verified</span>reliable</span>}
                  </td>
                  <td style={{ padding: "7px 12px" }}>{m.req}</td>
                  {m.noSamples ? <td colSpan={3} style={{ padding: "7px 12px" }}><span className="r9-nodata" title="Latency is logged since Nov 9. This row has no timed requests." aria-label="No samples"><span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>No samples</span></td> : <><td style={{ padding: "7px 12px" }}><span className="r9-mini-track"><i style={{ width: m.tpsW, background: "var(--violet)" }} /></span>{m.tps}</td><td style={{ padding: "7px 12px" }}>{m.ttft}</td><td style={{ padding: "7px 12px" }}>{m.lat}</td></>}
                  <td style={{ padding: "7px 12px" }}>{m.configError ? <span className="r9-nodata" title="This model is not routed.">Not routed</span> : <><span className="r9-mini-track"><i style={{ width: m.sW, background: m.sC }} /></span>{m.succ}</>}</td>
                  <td style={{ padding: "7px 12px" }}>{m.vpr}</td>
                  <td style={{ padding: "7px 12px", color: "var(--tx3)" }}>{m.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: "var(--tx3)", padding: "8px 16px 12px", margin: 0 }}>{r.note}</p>
      </div>
    </div>
  );
}

function ToolsTab({ v, error, loading }) {
  const t = v.tl;
  const card = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: 16, minWidth: 0 };
  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--tx2)" }}>Tool names only. Arguments and results are never stored.</p>
      {loading ? <p>Counting tool calls…</p> : error ? <p role="alert">Could not load tool calls: {error}</p> : !t.hasData ? (
        <div style={{ ...card, textAlign: "center", padding: 40 }}><strong>{t.emptyTitle}</strong><p>No tool calls were recorded in this range.</p></div>
      ) : (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ ...card, flex: "2 1 560px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <strong>TOOL CALLS</strong>
              <div aria-label="Filter tools by role" className="r9-tool-filters">
                {t.roleBtns.map((b) => <button key={b.label} onClick={b.on} aria-pressed={b.on2} style={b.style}>{b.label}</button>)}
                {t.directModelBtns.length > 0 && <><span className="r9-tool-filter-divider">Direct models</span>{t.directModelBtns.map((b) => <button key={b.label} onClick={b.on} aria-pressed={b.on2} style={b.style}>{b.label}</button>)}</>}
              </div>
            </div>
            <div className="r9-tool-legend"><span>By role:</span>{t.legend.map((l) => <span key={l.role}><i style={{ background: l.c }} />{l.role}</span>)}{t.directLegend.length > 0 && <><span className="r9-tool-legend-divider">Direct models</span>{t.directLegend.map((l) => <span key={l.model}><i style={{ background: l.c }} /><code>{l.model}</code></span>)}</>}</div>
            <div style={{ overflowX: "auto" }}>
              <table className="r9-tools-table" style={{ width: "100%", textAlign: "left", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Error %</th><th>By role</th><th>Top model (all roles)</th></tr></thead>
                <tbody>{t.rows.map((r) => <tr key={r.name} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "10px 8px 10px 0" }} title={r.name}>{r.name}</td><td>{r.calls}</td><td>{r.errors}</td><td>{r.pct}</td>
                  <td><div title={r.split.map((s) => `${s.label}: ${s.calls}`).join(", ")} aria-label={r.split.map((s) => `${s.label}: ${s.calls}`).join(", ")} className="r9-tool-bar">{r.split.map((s) => <span key={`${s.role}-${s.model || ""}`} title={`${s.label}: ${s.calls}`} style={{ width: `${s.f}%`, background: s.c }} />)}</div></td>
                  <td>{r.topModel}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {t.none && <p>No tool calls for this role.</p>}
            <p style={{ fontSize: 11, color: "var(--tx3)" }}>{t.note} {t.sampleNote}</p>
          </div>
          <div style={{ ...card, flex: "1 1 250px" }}><strong>TOP TOOLS PER ROLE</strong>
            {t.perRole.map((r) => <div key={r.role} style={{ marginTop: 16 }}><span style={r.chip}>{r.role}</span>
              {r.items.map((item) => <div key={item.name} style={{ marginTop: 8, fontSize: 12 }}><div style={{ display: "flex", justifyContent: "space-between" }}><span>{item.name}</span><span>{item.calls}</span></div><div style={{ height: 5, background: "var(--seg)", borderRadius: 4 }}><div style={{ width: item.w, height: "100%", background: r.c, borderRadius: 4 }} /></div></div>)}
            </div>)}
          </div>
        </div>
      )}
      {!t.hasData && !loading && !error && t.sampleNote && <p style={{ fontSize: 11, color: "var(--tx3)" }}>{t.sampleNote}</p>}
    </div>
  );
}
