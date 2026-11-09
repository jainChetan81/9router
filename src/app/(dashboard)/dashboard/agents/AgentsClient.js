"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RangeBar from "../spend/RangeBar";
import { buildView } from "./view";
import "../spend/spend.css";
import "./agents.css";

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
  const [detail, setDetail] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [tools, setTools] = useState(null);
  const [toolsError, setToolsError] = useState("");
  const [combos, setCombos] = useState([]);
  const [models, setModels] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [overridesBySession, setOverridesBySession] = useState({});
  const [revisions, setRevisions] = useState({});
  const [draft, setDraft] = useState({});
  const [cf, setCf] = useState(false);
  const [toast, setToast] = useState(null);
  const [mode, setMode] = useState("loading");
  const [errorText, setErrorText] = useState("");
  const [ui, setUi] = useState({ tab: "live", paused: false, ago: 0, q: "", fClient: "", fRole: "", sel: null, exp: {}, focus: null, hov: null, pick: null, zoom: null, gOff: 0, drawer: null });
  const set = useCallback((p) => setUi((u) => ({ ...u, ...(typeof p === "function" ? p(u) : p) })), []);
  const [theme, setTheme] = useState("light");
  const [vw, setVw] = useState(1440);
  const [tick, setTick] = useState(0); // bump to force live + range + detail reloads

  useEffect(() => {
    Promise.all([getJson("/api/combos"), getJson("/api/models")]).then(([c, m]) => {
      setCombos(c.combos || []); setModels(m.models || []);
    }).catch(() => {});
  }, []);

  const refreshOverrides = useCallback(async (sid) => {
    if (!sid) return {};
    const data = await getJson(`/api/agents/sessions/${encodeURIComponent(sid)}/overrides`);
    setOverrides(data.overrides || []);
    setRevisions(data.revisions || {});
    return data;
  }, []);
  const applyOverrides = useCallback(async (sid, changes) => {
    try {
      let auditWarning = false;
      for (const change of changes) {
        const res = await fetch(`/api/agents/sessions/${encodeURIComponent(sid)}/overrides`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ combo: change.role, model: change.to, mode: change.mode, fallback: change.mode === "member", expiry: change.expiry === "Session end" ? "session" : change.expiry, revision: revisions[change.role] ?? 0, confirmExpensive: /opus|fable/i.test(change.to) }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) { await refreshOverrides(sid); setToast("Changed elsewhere. Reloaded."); return; }
        if (!res.ok) throw new Error(body.error || "Unable to save routing");
        auditWarning ||= !!body.auditWarning;
      }
      await refreshOverrides(sid);
      setToast(auditWarning ? "Routing saved, but the audit entry could not be recorded." : "Routing saved for s·" + sid + " · applies from the next request");
    } catch (error) { setToast(error.message || "Unable to save routing."); }
  }, [refreshOverrides, revisions]);
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
      try { const d = await getJson(`/api/agents/sessions/${encodeURIComponent(sid)}/overrides`); return [sid, d.overrides || []]; }
      catch { return [sid, null]; }
    })).then((entries) => { if (!cancelled) setOverridesBySession((old) => ({ ...old, ...Object.fromEntries(entries.filter(([, value]) => value !== null)) })); });
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

  const detailId = useRef(0);
  const loadDetail = useCallback(async (sid) => {
    if (!sid) { setDetail(null); return; }
    const id = ++detailId.current;
    try {
      const d = await getJson(`/api/agents/sessions/${encodeURIComponent(sid)}`);
      if (id !== detailId.current) return;
      setDetail(d);
    } catch { setDetail(null); }
  }, []);
  const sel = ui.sel || sessions?.[0]?.session || null;
  useEffect(() => {
    if (ui.tab !== "sessions" || !sel) return;
    const t = setTimeout(() => loadDetail(sel), 0);
    return () => clearTimeout(t);
  }, [ui.tab, sel, tick, loadDetail]);

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
    focus: (f) => set((u) => ({ ...u, focus: f })),
    hover: (h) => set({ hov: h }),
    pick: (p) => set({ pick: p }),
    zoom: (k) => set({ zoom: k, gOff: 0 }),
    pan: (d) => set((u) => ({ ...u, gOff: Math.max(0, (u.gOff || 0) + d) })),
    openDrawer: (sid) => { set({ drawer: sid }); if (!sid) { setOverrides([]); setDraft({}); setCf(false); } },
    openTimeline: (sid) => { if (sid) { set({ tab: "sessions", sel: sid }); } else set({ tab: "sessions" }); setTick((x) => x + 1); },
  }), [set]);

  const v = useMemo(() => buildView({ live, sessions, totalSessions, detail, analytics, tools, range, ui: { ...ui, mode, errorText }, act, vw, combos, models, overrides, overridesBySession, revisions, draft, cf, toast,
    setDraft: (update) => setDraft((old) => ({ ...old, ...(typeof update === "function" ? update(old) : update) })),
    setCf, setToast, applyOverrides, reloadOverrides: refreshOverrides,
    act: { ...act, applyOverrides, revertOverride } }), [live, sessions, totalSessions, detail, analytics, tools, range, ui, mode, errorText, act, vw, combos, models, overrides, overridesBySession, revisions, draft, cf, toast, applyOverrides, refreshOverrides, revertOverride]);

  const isLoading = mode === "loading", isError = mode === "error", ready = !isLoading && !isError;
  const onRange = (r) => { setRange(r); set({ hov: null, pick: null, focus: null, sel: null }); setDetail(null); };
  const retry = act.retry;

  return (
    <div data-r9={theme}>
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "22px 22px 40px" }}>
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1 className="r9-h1" style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Agents</h1>
              <span title="Which agent runs each request. Role = the combo that routed it: main, implementer, reviewer, thinker, scout, background (Claude Code Haiku jobs), or direct (single model, no combo)." style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, padding: "2px 9px", borderRadius: 999, background: v.status.bg, color: v.status.c, whiteSpace: "nowrap" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>smart_toy</span>{v.status.text}
              </span>
            </div>
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--tx2)" }}>Async subagents (T3 Code) and sync implementers (combos), mixed in one live view.</p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--seg)" }}>
              {v.tabs.map((t) => (
                <button key={t.label} onClick={t.on} style={t.style} aria-label={t.count ? t.label + " " + t.count : t.label}>
                  {t.dot && <span style={t.dot} />}{t.label}{t.count && <span style={{ fontSize: 11.5, color: "var(--tx2)" }}>{t.count}</span>}
                </button>
              ))}
            </div>
            {ui.tab === "live" ? (
              <button onClick={v.togglePause} aria-label={v.paused ? "Resume live feed" : "Pause live feed"} style={{ display: "flex", alignItems: "center", gap: 7, border: 0, background: "transparent", padding: 0, font: "inherit", fontSize: 12, color: v.fresh.c, fontWeight: 600, cursor: "pointer" }}>
                <span style={v.fresh.dot} />{v.fresh.text}<span className="r9-hacc" style={{ fontFamily: "'Material Symbols Outlined'", fontSize: 15 }}>{v.fresh.icon}</span>{v.fresh.btn}
              </button>
            ) : (
              <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--seg)", maxWidth: "100%", overflowX: "auto", boxSizing: "border-box" }}>
                <RangeBar preset={v.preset} customLabel={v.customLabel} onChange={onRange} />
              </div>
            )}
          </div>
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
        {ready && !v.v.empty && ui.tab === "sessions" && <SessionsTab v={v} ui={ui} />}
        {ready && !v.v.empty && ui.tab === "roles" && <RolesTab v={v} />}
        {ready && !v.v.empty && ui.tab === "tools" && <ToolsTab v={v} error={toolsError} loading={!tools && !toolsError} />}

        {v.dr && (
          <div role="dialog" aria-modal="true" aria-label={v.dr.aria} onClick={v.closeDrawer} style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(20,12,8,.4)", display: "flex", justifyContent: "flex-end" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: v.dr.w, maxWidth: "100vw", height: "100%", overflowY: "auto", background: "var(--card)", borderLeft: "1px solid var(--line2)", padding: "20px 22px 28px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>Change routing · {v.dr.sid}</div>
                  <div style={{ fontSize: 12, color: "var(--tx2)" }}>{v.dr.client} · started {v.dr.started}</div>
                </div>
                <button onClick={v.closeDrawer} aria-label="Close routing panel" style={{ border: 0, background: "var(--seg)", borderRadius: 7, width: 30, height: 30, cursor: "pointer", fontFamily: "'Material Symbols Outlined'", fontSize: 18, color: "var(--tx2)" }}>close</button>
              </div>
              {v.dr.rows.map((r) => (
                <div key={r.role} style={r.rowStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={r.chip}>{r.role}</span>
                    <span style={{ fontSize: 12, color: "var(--tx2)" }}>now: <b>{r.cur}</b></span>
                  {r.status && <span style={r.statusStyle}>{r.status}</span>}
                  {r.canRevert && <button onClick={r.revert} style={{ marginLeft: "auto", height: 26, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Revert</button>}
                  </div>
                {r.locked ? <p style={{ margin: 0, fontSize: 12, color: "var(--tx2)" }}>🔒 {r.lockText}</p> : <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "var(--tx3)" }}>MODEL</span><select value={r.sel} onChange={r.onSel} style={{ height: 32, border: "1px solid var(--line2)", borderRadius: 7, background: "var(--bg)", color: "var(--tx)", fontFamily: "var(--mono)", fontSize: 12, padding: "0 8px" }}>{r.opts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</select></label>
                  {r.isOther && <label style={{ display: "flex", flexDirection: "column", gap: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "var(--tx3)" }}>OTHER MODEL</span><select value={r.other} onChange={r.onOther} style={{ height: 32, border: "1px solid var(--line2)", borderRadius: 7, background: "var(--bg)", color: "var(--tx)", fontFamily: "var(--mono)", fontSize: 12, padding: "0 8px" }}>{r.otherOpts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</select></label>}
                  {r.warn && <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--amberbg)", fontSize: 12, color: "var(--tx)" }}>⚠ {r.warn}</div>}
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}><div><div style={{ fontSize: 11, fontWeight: 600, color: "var(--tx3)", marginBottom: 4 }}>MODE</div><div role="group" aria-label={r.modeAria} style={{ display: "flex", gap: 2, padding: 2, borderRadius: 8, background: "var(--seg)" }}>{r.modes.map((m) => <button key={m.label} onClick={m.on} aria-pressed={m.on2} title={m.tip} style={m.style}>{m.label}</button>)}</div></div><label style={{ display: "flex", flexDirection: "column", gap: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "var(--tx3)" }}>UNTIL</span><select value={r.expiry} onChange={r.onExp} style={{ height: 28, border: "1px solid var(--line2)", borderRadius: 7, background: "var(--bg)", color: "var(--tx)", font: "inherit", fontSize: 12 }}><option value="Session end">Session end</option><option value="1h">1 hour</option><option value="2h">2 hours</option></select></label></div>
                  {r.strict && <span style={{ fontSize: 11.5, color: "var(--tx2)" }}>No fallback. If this model fails, the request fails visibly.</span>}
                </>}
                </div>
              ))}
            <div style={{ padding: "10px 12px", borderRadius: 8, background: "var(--seg)", fontSize: 12, color: "var(--tx2)" }}>Applies from the next request only. Requests in flight keep their model. Codex sessions can only use OpenAI models. <a href="/dashboard/combos">Edit combo members for everyone →</a></div>
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, paddingTop: 12, borderTop: "1px solid var(--line)" }}><span style={{ marginRight: "auto", fontSize: 12, color: "var(--tx3)" }}>{v.dr.changeText}</span><button onClick={v.closeDrawer} style={{ height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12.5, cursor: "pointer" }}>Cancel</button><button onClick={v.dr.apply} disabled={v.dr.noChanges} style={v.dr.applyStyle}>Apply</button></div>
            </div>
          </div>
        )}
        {v.cm && <>
          <div onClick={v.cancelCf} style={{ position: "fixed", inset: 0, zIndex: 95, background: "rgba(20,10,5,.28)" }} />
          <div role="dialog" aria-modal="true" aria-label={v.cm.title} style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 96, width: 460, maxWidth: "calc(100vw - 32px)", background: "var(--card)", border: "1px solid var(--line2)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 24, display: "flex", flexDirection: "column", gap: 14, boxSizing: "border-box" }}>
            <strong>{v.cm.title}</strong>{v.cm.lines.map((line) => <div key={line.role} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 12.5 }}><span style={line.chip}>{line.role}</span><span>{line.from}</span> → <b>{line.to}</b><span style={{ color: "var(--tx2)" }}>· {line.mode} · until {line.exp}</span></div>)}
            <span style={{ fontSize: 12.5, color: "var(--tx2)" }}>Applies from the next request. Requests in flight keep their model.</span><div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><button onClick={v.cancelCf}>Cancel</button><button onClick={v.doCf}>Apply</button></div>
          </div>
        </>}
        {v.toast && <div role="status" style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 99, display: "flex", alignItems: "center", gap: 16, minHeight: 40, padding: "0 8px 0 16px", borderRadius: 8, background: "var(--tx)", color: "var(--bg)", fontSize: 12.5, boxShadow: "var(--shadow)", maxWidth: "calc(100vw - 32px)" }}><span>{v.toast}</span><button onClick={v.closeToast} aria-label="Dismiss">×</button></div>}
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
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(150px,1fr))", gap: 10, overflowX: "auto" }}>
          {v.live.kpis.map((k) => <Kpi key={k.label} k={k} />)}
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {v.live.cards.map((c) => <LiveCard key={c.id} c={c} />)}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
        {v.live.kpis.map((k) => <Kpi key={k.label} k={k} mini />)}
      </div>
      {v.live.cards.map((c) => <LiveCard key={c.id} c={c} narrow />)}
    </div>
  );
}

function Kpi({ k, mini }) {
  return (
    <div title={k.tip} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "var(--shadow)", padding: mini ? "8px 10px" : "10px 12px", minWidth: mini ? 130 : 0 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".04em", color: "var(--tx3)", whiteSpace: "nowrap" }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: k.dot, marginRight: 5 }} />{k.label}</div>
      <div style={{ fontSize: mini ? 15 : 18, fontWeight: 700, color: k.c, fontVariantNumeric: "tabular-nums" }}>{k.value}</div>
      <div style={{ fontSize: 11, color: "var(--tx3)", whiteSpace: "nowrap" }}>{k.sub}</div>
    </div>
  );
}

function LiveCard({ c, narrow }) {
  return (
    <article style={{ ...c.wrap, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: "12px 14px", minWidth: narrow ? 0 : 300, flex: narrow ? "1 1 100%" : "1 1 320px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{c.id}</span>
        <span style={{ fontSize: 11.5, color: "var(--tx2)" }}>{c.client} · since {c.started}</span>
        {c.isChild && <span title={c.parentTip || ""} style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 5, background: "var(--seg)", color: "var(--tx2)" }}>inferred child</span>}
        {c.bgNote && <span title="Claude Code Haiku jobs: titles, summaries, WebSearch. Not subagents." style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 5, background: "var(--amberbg)", color: "var(--chipthink)" }}>+background</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
        {c.rows.map((r) => (
          <div key={r.role} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", opacity: r.op }}>
            <span style={r.chip}>{r.role}</span>
            <span title={r.model} style={{ maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--tx)" }}><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: r.mc, marginRight: 5 }} />{r.model}</span>
            <span style={{ fontSize: 11, color: "var(--tx3)" }}>{r.prov}</span>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2, fontSize: 11, color: r.stC }}><span style={r.dot} />{r.st}</span>
            <span title={r.sparkTip} style={{ fontSize: 11, color: "var(--tx3)", fontVariantNumeric: "tabular-nums" }}>{r.rpm}/m · {r.tps}t/s · {r.p50}</span>
            <span style={{ fontSize: 11, color: r.succC, fontVariantNumeric: "tabular-nums" }}>{r.succ}</span>
            {r.tag && <span style={r.tagStyle}>{r.tag}</span>}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={c.route} style={{ height: 28, padding: "0 12px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Change routing</button>
        <button onClick={c.timeline} style={{ height: 28, padding: "0 12px", borderRadius: 7, border: 0, background: "transparent", color: "var(--tx2)", font: "inherit", fontSize: 12, cursor: "pointer" }}>Timeline</button>
      </div>
    </article>
  );
}

function SessionsTab({ v, ui }) {
  if (!v.v.sess) return null;
  const t = v.tree, g = v.g, sm = v.sm;
  return (
    <div>
      {v.v.partial && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--tx2)", background: "var(--seg)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>history</span>{v.v.partialText}
        </div>
      )}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", ...v.lay }}>
        <div style={{ flex: v.lay.tf, maxWidth: v.lay.tmax, minWidth: 300 }}>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)" }}>
            <div style={{ padding: "12px 14px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
              <input value={t.q} onChange={t.onQ} placeholder="Filter s·session id…" aria-label="Filter sessions" style={{ height: 30, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", font: "inherit", fontSize: 12.5 }} />
              <div style={{ display: "flex", gap: 8 }}>
                <select value={t.fClient} onChange={t.onClient} aria-label="Filter by client" style={{ font: "inherit", fontSize: 12, height: 28, borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)" }}>
                  {t.clientOpts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
                <select value={t.fRole} onChange={t.onRole} aria-label="Filter by role" style={{ font: "inherit", fontSize: 12, height: 28, borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)" }}>
                  {t.roleOpts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--tx3)", alignSelf: "center" }}>{t.count}</span>
              </div>
            </div>
            <div style={{ borderTop: "1px solid var(--line)", maxHeight: 560, overflowY: "auto" }}>
              {t.none && <p style={{ padding: "24px 16px", fontSize: 12.5, color: "var(--tx3)", textAlign: "center" }}>No sessions match this filter.</p>}
              {t.rows.map((r, i) => (
                <button key={(r.isSess ? "s" : r.isRole ? "r" : "m") + i + r.label} onClick={r.on} style={{ ...r.style, paddingLeft: `calc(8px + ${r.pad})` }}>
                  {r.isSess && <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--tx3)" }}>{r.chev}</span>}
                  {r.isKid && <span className="material-symbols-outlined" style={{ fontSize: 14, color: "var(--tx3)" }} title="Delegated child (T3). Link inferred.">subdirectory_arrow_right</span>}
                  {r.isRole && <span style={r.chip}>{r.label}</span>}
                  {r.isModel && <span><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: r.mc, marginRight: 5 }} />{r.label}</span>}
                  {r.isSess && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}<span style={{ color: "var(--tx3)", fontSize: 11 }}> · {r.sub}</span></span>}
                  {r.live && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)", flex: "none" }} title="Live now" />}
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--tx3)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{r.req} · {r.tok} · {r.val}{+r.err > 0 && <span style={{ color: "var(--red)" }}> · {r.err}✕</span>}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ flex: v.lay.rf, minWidth: 320 }}>
          {g && sm && <Gantt v={v} ui={ui} />}
        </div>
      </div>
    </div>
  );
}

function Gantt({ v, ui }) {
  const g = v.g, sm = v.sm;
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{sm.id}</span>
        <span style={{ fontSize: 12, color: "var(--tx2)" }}>{sm.client} · {sm.when}</span>
        {sm.live && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)" }} title="Live now" />}
        <span style={{ marginLeft: "auto", display: "flex", gap: 2, padding: 3, borderRadius: 8, background: "var(--seg)" }}>
          {g.zooms.map((z) => <button key={z.label} onClick={z.on} style={z.style}>{z.label}</button>)}
        </span>
        <button onClick={g.prev} disabled={g.noPrev} aria-label="Pan earlier" style={g.prevStyle}>chevron_left</button>
        <button onClick={g.next} disabled={g.noNext} aria-label="Pan later" style={g.nextStyle}>chevron_right</button>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "8px 0" }}>
        {sm.stats.map((s) => (
          <span key={s.l} title={s.s || ""} style={{ fontSize: 12, color: "var(--tx2)" }}>{s.l}: <b style={{ color: s.c }}>{s.v}</b></span>
        ))}
        <span style={{ fontSize: 12, color: "var(--tx2)" }}>Models: {sm.models.map((m, i) => <span key={m.m} title={m.m}><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: m.c, marginRight: 3, marginLeft: i ? 6 : 0 }} />{m.m.split("-")[0]}</span>)}</span>
        <button onClick={sm.route} style={{ height: 26, padding: "0 10px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--card)", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Change routing</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 4 }}>{g.window}</div>
      <div onMouseLeave={v.unhover} style={{ position: "relative" }}>
        <div style={{ display: "flex", position: "relative", height: 18 }}>
          {g.ticks.map((t, i) => <span key={i} style={{ position: "absolute", left: t.l, fontSize: 10.5, color: "var(--tx3)", transform: "translateX(-50%)", fontVariantNumeric: "tabular-nums" }}>{t.label}</span>)}
        </div>
        {g.gaps.map((gp, i) => <div key={i} title={"Idle gap: " + gp.label} style={{ position: "absolute", left: gp.l, width: gp.w, top: 24, bottom: 0, background: "repeating-linear-gradient(135deg,transparent 0 4px,var(--line) 4px 5px)", borderRadius: 4, pointerEvents: "none" }} />)}
        {g.now && <div style={{ position: "absolute", left: g.nowL, top: 20, bottom: 0, width: 1, background: "var(--green)" }} title="now" />}
        {g.lanes.map((l, li) => (
          <div key={li} title={l.tip} style={{ display: "flex", alignItems: "center", gap: 8, height: 39, opacity: l.op }}>
            <button onClick={l.focus} style={{ width: 120, flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, border: 0, background: "transparent", padding: 0, font: "inherit", cursor: "pointer", textAlign: "left" }}>
              <span style={l.chip}>{l.role}</span>
              <span style={{ fontSize: 10.5, color: "var(--tx3)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.model}</span>
            </button>
            <div style={{ position: "relative", flex: 1, height: 39 }}>
              {l.bars.map((b, ri) => <button key={ri} title={b.aria} onMouseEnter={b.hover} onFocus={b.hover} onClick={b.pick} style={b.style} />)}
            </div>
          </div>
        ))}
        {g.hov && (
          <div style={{ position: "absolute", ...g.hov, zIndex: 30, width: 260, background: "var(--card)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 12px 32px rgba(40,20,10,.16)", padding: "10px 12px", pointerEvents: "none" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>{g.hov.model}</div>
            <div style={{ fontSize: 11.5, color: "var(--tx2)", marginBottom: 6 }}>{g.hov.prov} · <span style={g.hov.stStyle}>{g.hov.status}</span></div>
            {g.hov.facts.map((f) => <div key={f.l} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}><span style={{ color: "var(--tx3)" }}>{f.l}</span><b style={{ color: f.c }}>{f.v}</b></div>)}
          </div>
        )}
        {g.pick && (
          <div role="dialog" aria-label={"Request " + g.pick.rid} style={{ position: "absolute", ...g.pick, zIndex: 31, width: 300, background: "var(--card)", border: "1px solid var(--line2)", borderRadius: 10, boxShadow: "0 12px 32px rgba(40,20,10,.16)", padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{g.pick.model}</span>
              <span style={g.pick.stStyle}>{g.pick.status}</span>
              <button onClick={v.closePick} aria-label="Close request details" style={{ marginLeft: "auto", border: 0, background: "var(--seg)", borderRadius: 6, width: 24, height: 24, cursor: "pointer", fontFamily: "'Material Symbols Outlined'", fontSize: 15, color: "var(--tx2)" }}>close</button>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--tx3)", margin: "2px 0 6px" }}>{g.pick.rid}</div>
            {g.pick.facts.map((f) => <div key={f.l} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}><span style={{ color: "var(--tx3)" }}>{f.l}</span><b style={{ color: f.c, fontFamily: f.ff }}>{f.v}</b></div>)}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        {g.legend.map((l) => <span key={l.m} title={l.m} style={{ fontSize: 11, color: "var(--tx2)" }}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: l.c, marginRight: 4 }} />{l.m}</span>)}
      </div>
      <p style={{ fontSize: 11, color: "var(--tx3)", margin: "8px 0 0" }}>{g.note}</p>
    </div>
  );
}

function RolesTab({ v }) {
  const r = v.ro;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow)", padding: "14px 16px" }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".05em", color: "var(--tx2)", marginBottom: 10 }}>SHARE OF WORK</div>
        {r.share.map((s) => (
          <div key={s.label} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: "var(--tx2)" }}>{s.label}</span><b style={{ color: s.c }}>{s.total}</b>
            </div>
            <div role="img" aria-label={s.aria} style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "var(--seg)" }}>
              {s.segs.map((g, i) => <span key={i} title={g.t} style={{ flex: g.f, background: g.c }} />)}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
          {r.legend.map((l) => (
            <span key={l.role} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--tx2)" }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: l.c }} /><span style={l.chip}>{l.role}</span>{l.req} req · {l.tok} tok · {l.val} val
            </span>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(180px,1fr))", gap: 10 }}>
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
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
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
                <tr key={"h" + i} style={{ background: "var(--seg)" }}>
                  <td colSpan={8} style={{ padding: "7px 12px" }}><span style={m.chip}>{m.role}</span> <span style={{ fontSize: 11.5, color: "var(--tx3)" }}>{m.desc}</span></td>
                </tr>
              ) : (
                <tr key={"r" + i} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "7px 12px" }}><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: m.mc, marginRight: 5 }} />{m.model} <span style={{ color: "var(--tx3)", fontSize: 11 }}>· {m.prov}</span>
                    {m.fast && <span style={r.fastChip}><span className="material-symbols-outlined" style={{ fontSize: 12 }}>bolt</span>fastest</span>}
                    {m.rel && <span style={{ marginLeft: 4, ...r.relChip }}><span className="material-symbols-outlined" style={{ fontSize: 12 }}>verified</span>reliable</span>}
                  </td>
                  <td style={{ padding: "7px 12px" }}>{m.req}</td>
                  <td style={{ padding: "7px 12px" }}><span style={{ display: "inline-block", width: 48, height: 5, borderRadius: 3, background: "var(--seg)", verticalAlign: "middle", marginRight: 6 }}><span style={{ display: "block", height: "100%", width: m.tpsW, borderRadius: 3, background: "var(--violet)" }} /></span>{m.tps}</td>
                  <td style={{ padding: "7px 12px" }}>{m.ttft}</td>
                  <td style={{ padding: "7px 12px" }}>{m.lat}</td>
                  <td style={{ padding: "7px 12px" }}><span style={{ display: "inline-block", width: 48, height: 5, borderRadius: 3, background: "var(--seg)", verticalAlign: "middle", marginRight: 6 }}><span style={{ display: "block", height: "100%", width: m.sW, borderRadius: 3, background: m.sC }} /></span>{m.succ}</td>
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
              <div aria-label="Filter tools by role" style={{ display: "flex", flexWrap: "wrap", background: "var(--seg)", borderRadius: 9, padding: 3 }}>
                {t.roleBtns.map((b) => <button key={b.label} onClick={b.on} aria-pressed={b.on2} style={b.style}>{b.label}</button>)}
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Error %</th><th>By role</th><th>Top model (all roles)</th></tr></thead>
                <tbody>{t.rows.map((r) => <tr key={r.name} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "10px 8px 10px 0" }}>{r.name}</td><td>{r.calls}</td><td>{r.errors}</td><td>{r.pct}</td>
                  <td><div aria-label={r.split.map((s) => `${s.role}: ${s.calls}`).join(", ")} style={{ display: "flex", width: 100, height: 7, overflow: "hidden", borderRadius: 5 }}>{r.split.map((s) => <span key={s.role} title={`${s.role}: ${s.calls}`} style={{ width: `${s.f}%`, background: s.c }} />)}</div></td>
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
