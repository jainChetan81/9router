// Builds the Agents page view model from /api/agents/* data. Ported from the
// Claude Design "Agents.dc.html" renderVals so markup bindings stay 1:1.
// Pure function: no fetch, no DOM. Callbacks come in via `act`.
import { RC, SHORT, usd, cnt } from "../spend/view.js";

const IST = "Asia/Kolkata";
const ROLE_ORDER = ["main", "implementer", "scout", "reviewer", "thinker", "background", "direct"];
const ROLEDESC = { main: "single model, direct", implementer: "combo · sticky per session", scout: "combo · sticky per session", reviewer: "combo · sticky per session", thinker: "fusion · answers, one merges", background: "Claude Code Haiku jobs · not a subagent", direct: "single model, direct" };
const MC = {
  "claude-opus-5-5": "#7273ee", "claude-haiku-5-5": "#a9aaf7", "claude-sonnet-5-5": "#8f90f5", "claude-fable-5-1": "#b3b4fa",
  "gpt-6-luna": "#22a892", "gpt-6.1-terra": "#4fbfa9", "gpt-6.1-sol": "#7fd1c1", "gpt-6-astra": "#2f8f7c",
  "gemini-3.8-flash": "#e0a23a", "muse-spark-1.3-contributor": "#c98bd6",
  "glm-5.3-flash": "#e5603e", "glm-5.3": "#f08a6c", "qwen3.8-flash": "#d4a373", "kimi-k3.1-pro": "#b56576", "deepseek-v4.1-flash": "#4b84e8",
};
const FALLBACK_COLORS = ["#7273ee", "#22a892", "#e0a23a", "#c98bd6", "#e5603e", "#4b84e8", "#b56576", "#2f8f7c"];

export const mc = (m) => {
  if (!m) return "#a0958e";
  if (MC[m]) return MC[m];
  let h = 0;
  for (let i = 0; i < m.length; i++) h = (h * 31 + m.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
};
export const short = (m) => SHORT[m] || m;
export const prov = (m) => {
  if (!m) return "—";
  const l = m.toLowerCase();
  if (l.startsWith("claude")) return "Claude Code";
  if (l.startsWith("gpt") || l.startsWith("openai") || l.startsWith("codex")) return "OpenAI Codex";
  if (l.startsWith("gemini") || l.startsWith("antigravity")) return "Antigravity";
  if (l.startsWith("ocg/") || l.startsWith("opencode")) return "OpenCode Go";
  if (l.startsWith("muse")) return "Muse";
  if (l.startsWith("z-ai/") || l.includes("glm")) return "OpenRouter";
  if (l.includes("deepseek")) return "DeepSeek";
  return "—";
};

const hm = (ts) => { const d = new Date(ts); return Number.isNaN(+d) ? "—" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: IST }); };
const hms = (ts) => { const d = new Date(ts); return Number.isNaN(+d) ? "—" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: IST }); };
const dayLabel = (ts) => { const d = new Date(ts); return Number.isNaN(+d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: IST }); };
const durF = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
const fs = (s) => (s == null || !Number.isFinite(s) ? "—" : s < 10 ? s.toFixed(1) + " s" : s < 60 ? Math.round(s) + " s" : Math.floor(s / 60) + " m " + Math.round(s % 60) + " s");
const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const i = (b.length - 1) / 2; return (b[Math.floor(i)] + b[Math.ceil(i)]) / 2; };
const seg = (on) => ({ border: 0, height: 26, padding: "0 10px", borderRadius: 7, font: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap", background: on ? "var(--segon)" : "transparent", color: on ? "var(--tx)" : "var(--tx2)", fontWeight: on ? 600 : 400, boxShadow: on ? "0 1px 2px rgba(0,0,0,.08)" : "none" });

export function chip(role) {
  const c = RC[role] || ["var(--seg)", "var(--tx2)"];
  return { display: "inline-block", fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 5, background: c[0], color: role === "background" ? "var(--tx2)" : c[1], border: role === "background" ? "1px dashed var(--tx3)" : "1px solid transparent", whiteSpace: "nowrap", lineHeight: "16px" };
}

const call = (fn, ...args) => () => fn?.(...args);

function statusOf(q) {
  const s = String(q.status ?? "ok");
  if (s === "ok") return ["OK", "var(--green)", "var(--greenbg)"];
  if (s === "aborted") return ["Aborted", "var(--amber)", "var(--amberbg)"];
  return [s, "var(--red)", "var(--redbg)"];
}

export function buildView({ live, sessions, totalSessions, detail, analytics, tools, range, ui, act = {}, vw = 1440, now = Date.now(), combos = [], models = [], overrides = [], overridesBySession = {}, revisions = {}, draft = {}, cf = false, toast = null, setDraft = () => {}, setCf = () => {}, setToast = () => {}, applyOverrides = async () => {}, reloadOverrides = async () => {} }) {
  const tab = ui.tab || "live";
  const mode = ui.mode || "loading"; // loading | ready | empty | error | stale
  const ok = mode === "ready" || mode === "stale";
  const preset = range?.preset || "7D";
  const rangeTitle = { Today: "Today", "24h": "Last 24 hours", "7D": "Last 7 days", "30D": "Last 30 days", "60D": "All time", Custom: range?.label || "Custom range", All: "All time" }[preset] || preset;

  // ---------- live KPIs and cards ----------
  const liveSessions = live?.sessions || [];
  const topLevel = liveSessions.filter((s) => !s.parent);
  const kidOf = (id) => liveSessions.filter((s) => s.parent && (s.parent.session === id || s.parent === id));
  const allReq5 = liveSessions.reduce((a, s) => a + (s.reqPerMin || 0) * 5, 0);
  const tpsVals = liveSessions.map((s) => s.tpsRecent).filter((v) => v != null && Number.isFinite(v));
  const p50Vals = liveSessions.map((s) => s.p50TotalMs).filter((v) => v != null && Number.isFinite(v)).map((v) => v / 1000);
  const succW = liveSessions.reduce((a, s) => a + (s.reqPerMin || 0), 0);
  const succAvg = succW ? liveSessions.reduce((a, s) => a + (s.successRate ?? 100) * (s.reqPerMin || 0), 0) / succW : 100;
  const fails5 = Math.round(allReq5 * (1 - succAvg / 100));
  const liveKids = kidOfAll(liveSessions);
  const kpis = [
    ["ACTIVE SESSIONS", String(topLevel.length), liveKids ? liveKids + " delegated children" : "child links need parent IDs", "Sessions with a request in the last 5 minutes." + (liveKids ? " T3 delegated children count under their parent." : " The live feed carries no parent links yet, so children cannot be nested here."), "var(--acc)", "var(--tx)"],
    ["IN FLIGHT", "—", "not tracked yet", "The in-flight registry (P2) is not built yet, so running requests cannot be counted.", "var(--green)", "var(--tx3)"],
    ["REQUESTS / MIN", (allReq5 / 5).toFixed(1), Math.round(allReq5) + " requests in 5 min", "All agents, background jobs included, over the last 5 minutes.", "var(--blue)", "var(--tx)"],
    ["TOKENS / S", tpsVals.length ? String(Math.round(med(tpsVals))) : "—", "median output speed", "Median output tokens per second across live sessions, counted after the first token.", "var(--violet)", tpsVals.length ? "var(--tx)" : "var(--tx3)"],
    ["LATENCY P50", p50Vals.length ? fs(med(p50Vals)) : "—", "start to last token", "Median request latency over live sessions. P95 needs per-request samples (P2).", "var(--tx3)", "var(--tx)"],
    ["SUCCESS RATE", succAvg.toFixed(1) + "%", fails5 + " failed of " + Math.round(allReq5), "Requests in the last 5 minutes that returned a complete response.", succAvg < 95 ? "var(--red)" : "var(--green)", succAvg < 95 ? "var(--red)" : "var(--tx)"],
  ].map(([label, value, sub, tip, dot, c]) => ({ label, value, sub, tip, dot, c }));

  const card = (s, isChild, more) => {
    const lastMs = Date.parse(s.lastTs);
    const routeOverrides = overridesBySession[s.session] || [];
    const rows = (s.roles || []).map((r) => {
      const isBg = r.role === "background";
      const entry = routeOverrides.find((e) => e.combo === r.role);
      const currentModel = entry?.status === "active" ? entry.model : r.model || "unknown";
      const pending = entry?.status === "pending";
      return {
        role: r.role, chip: chip(r.role), model: currentModel, prov: prov(currentModel), mc: mc(currentModel),
        op: isBg ? 0.72 : 1, st: "waiting", stC: "var(--tx2)",
        dot: { width: 8, height: 8, borderRadius: "50%", flex: "none", background: "var(--tx3)" },
        rpm: r.requests != null ? (r.requests / 5).toFixed(1) : "—", tps: "—", p50: "—",
        succ: s.successRate == null ? "—" : (s.successRate === 100 ? "100" : s.successRate.toFixed(1)) + "%",
        succC: s.successRate == null ? "var(--tx3)" : s.successRate < 95 ? "var(--red)" : "var(--tx)",
        spark: "", sparkTip: "Per-minute history needs the in-flight registry (P2).",
        tag: pending ? "pending → " + short(entry.model) : entry?.mode === "override" ? "override" : entry?.mode === "member" ? "Routing changed" : "",
        tagStyle: pending ? { fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "var(--amberbg)", color: "var(--amber)", whiteSpace: "nowrap" } : entry?.mode === "override" ? { fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "var(--greenbg)", color: "var(--green)" } : { fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "var(--bluebg)", color: "var(--blue)" },
        _override: entry,
      };
    });
    const flags = rows.map((r) => r._override).filter(Boolean);
    return {
      id: "s·" + s.session, client: s.client || "Unknown", started: Number.isFinite(lastMs) ? hm(lastMs) : "—",
      rows, isChild, more,
      wrap: { position: "relative", marginLeft: isChild ? (vw < 900 ? 28 : 40) : 0 },
      parentId: s.parent ? "s·" + (s.parent.session || s.parent) : "",
      infTip: "T3 sends no parent id. Linked by key and timing, so the link is inferred.",
      hasOverride: flags.some((e) => e.mode === "override" && e.status === "active"), hasChanged: flags.some((e) => e.mode === "member" && e.status === "active"), hasPending: flags.some((e) => e.status === "pending"),
      bgNote: (s.roles || []).some((r) => r.role === "background"),
      route: call(act.openDrawer, s.session),
      timeline: call(act.openTimeline, s.session),
    };
  };
  const liveCards = [];
  topLevel.forEach((s) => { liveCards.push(card(s, false, false)); kidOf(s.session).forEach((k, i, arr) => liveCards.push(card(k, true, i < arr.length - 1))); });

  // ---------- sessions tree ----------
  const sessList = sessions || [];
  const byId = new Map(sessList.map((s) => [s.session, s]));
  const kidsOf = (id) => sessList.filter((s) => s.parent && (s.parent.session || s.parent) === id);
  const qq = (ui.q || "").replace(/^s·?/, "").toLowerCase().trim();
  const matches = (s) => (!qq || s.session.toLowerCase().includes(qq)) && (!ui.fClient || s.client === ui.fClient) && (!ui.fRole || (s.roles || []).some((r) => r.role === ui.fRole));
  const parentOf = (s) => { const p = s.parent && (s.parent.session || s.parent); return p && byId.get(p) ? p : null; };
  const topList = sessList.filter((s) => !parentOf(s)).filter((s) => matches(s) || kidsOf(s.session).some(matches)).sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
  const selId = (ui.sel && byId.get(ui.sel)) ? ui.sel : (topList[0] ? topList[0].session : null);

  const rowStyle = (selected, focused) => ({ display: "grid", gridTemplateColumns: "minmax(0,1fr) 44px 54px 62px 30px", gap: 8, alignItems: "center", width: "100%", minHeight: 32, flexShrink: 0, padding: "5px 8px", border: 0, borderTop: "1px solid var(--line)", background: selected ? "var(--acc2)" : focused ? "var(--seg)" : "transparent", color: "var(--tx)", font: "inherit", fontSize: 12, textAlign: "left", cursor: "pointer", fontVariantNumeric: "tabular-nums", boxSizing: "border-box" });
  const metric = (req, tok, val, err, bold) => ({ req: req.toLocaleString("en-US"), tok: cnt(tok), val: usd(val), fw: bold ? 600 : 400, err: String(err), errC: err ? "var(--red)" : "var(--tx3)" });
  const sumAll = (s) => ({ req: s.requests || 0, tok: s.tokens || 0, val: s.value || 0, err: s.errors || 0 });
  const treeRows = [];
  const fo = ui.focus;
  const pushSess = (s, depth, isKid) => {
    const m = sumAll(s);
    const open = ui.exp[s.session] ?? (s.session === selId || (selId && parentOf(byId.get(selId) || {}) === s.session));
    const rootId = parentOf(s) || s.session;
    const firstMs = Date.parse(s.firstTs), lastMs = Date.parse(s.lastTs);
    treeRows.push({
      isSess: true, isRole: false, isModel: false, isKid, label: "s·" + s.session,
      sub: (s.client || "Unknown") + " · " + (Number.isFinite(firstMs) ? dayLabel(firstMs) + " " + hm(firstMs) : ""),
      live: Number.isFinite(lastMs) && now - lastMs < 5 * 60 * 1000, inferred: isKid,
      chev: open ? "expand_more" : "chevron_right", exp: open, pad: depth * 16 + "px",
      style: rowStyle(selId === s.session, false), ...metric(m.req, m.tok, m.val, m.err, true),
      on: () => act.select?.(rootId, s.session),
    });
    if (!open) return;
    (s.roles || []).forEach((r) => {
      const rm = (r.models || []).reduce((a, x) => ({ req: a.req + (x.requests || 0), tok: a.tok + (x.tokens || 0), val: a.val + (x.value || 0), err: a.err + Math.max(0, (x.totalReqs ?? x.requests ?? 0) - (x.oks ?? x.totalReqs ?? x.requests ?? 0)) }), { req: 0, tok: 0, val: 0, err: 0 });
      const foc = fo && fo.sid === s.session && fo.role === r.role && !fo.model;
      treeRows.push({ isSess: false, isRole: true, isModel: false, isKid: false, label: r.role, chip: chip(r.role), pad: (depth * 16 + 22) + "px", style: rowStyle(false, foc), ...metric(rm.req, rm.tok, rm.val, rm.err),
        on: () => act.focus?.({ sid: s.session, role: r.role }) });
      const seen = new Map();
      (r.models || []).forEach((x) => { const k = (x.model || "unknown") + "|" + (x.provider || ""); if (!seen.get(k)) seen.set(k, []); seen.get(k).push(x); });
      [...seen.entries()].forEach(([k, xs]) => {
        const mm = xs.reduce((a, x) => ({ req: a.req + (x.requests || 0), tok: a.tok + (x.tokens || 0), val: a.val + (x.value || 0) }), { req: 0, tok: 0, val: 0 });
        const name = k.split("|")[0];
        const fm = fo && fo.sid === s.session && fo.role === r.role && fo.model === name;
        treeRows.push({ isSess: false, isRole: false, isModel: true, isKid: false, label: name, mc: mc(name), pad: (depth * 16 + 40) + "px", style: rowStyle(false, fm), ...metric(mm.req, mm.tok, mm.val, 0),
          on: () => act.focus?.({ sid: s.session, role: r.role, model: name }) });
      });
    });
  };
  topList.forEach((s) => { pushSess(s, 0, false); kidsOf(s.session).filter((k) => matches(k) || matches(s)).forEach((k) => pushSess(k, 1, true)); });
  const clientSet = [...new Set(sessList.map((s) => s.client).filter(Boolean))].sort();
  const roleSet = [...new Set(sessList.flatMap((s) => (s.roles || []).map((r) => r.role)))].sort();
  const tree = {
    rows: treeRows, none: treeRows.length === 0, count: (totalSessions ?? sessList.length) + " in range",
    q: ui.q || "", fClient: ui.fClient || "", fRole: ui.fRole || "",
    clientOpts: [{ v: "", label: "All clients" }, ...clientSet.map((c) => ({ v: c, label: c }))],
    roleOpts: [{ v: "", label: "All roles" }, ...roleSet.map((r) => ({ v: r, label: r }))],
    onQ: (e) => act.setQ?.(e.target.value), onClient: (e) => act.setClient?.(e.target.value), onRole: (e) => act.setRole?.(e.target.value),
  };

  // ---------- gantt ----------
  let g = null, sm = null;
  const det = detail && detail.session ? detail : null;
  if (det && (det.agents || []).length) {
    const kidDetails = [];
    const laneList = (det.agents || []).map((a) => ({ s: det, l: a, kid: false }));
    const allReq = laneList.flatMap((o) => (o.l.requests || []).map((q) => ({ ...q, s: Date.parse(q.ts) }))).filter((q) => Number.isFinite(q.s)).sort((a, b) => a.s - b.s);
    const T0 = allReq.length ? allReq[0].s : Date.parse(det.firstTs);
    const T1 = Math.max(allReq.length ? allReq[allReq.length - 1].s + ((allReq[allReq.length - 1].totalMs) || 0) : 0, Date.parse(det.lastTs) || 0, T0);
    const spanS = Math.max(1, T1 - T0);
    const Z = { "15m": 900e3, "1h": 3600e3, "6h": 21600e3, Day: 86400e3 };
    const auto = spanS <= 840e3 ? "15m" : spanS <= 3420e3 ? "1h" : spanS <= 19800e3 ? "6h" : "Day";
    const zoom = ui.zoom || auto, len = Z[zoom];
    let w0, canPan = false;
    if (zoom === "Day" || len >= spanS) w0 = Math.max(0, T0 - (len - spanS) / 2);
    else { canPan = true; w0 = Math.max(T0 - 30e3, T1 + 30e3 - len - (ui.gOff || 0) * len / 2); }
    const w1 = w0 + len;
    const L = (x) => ((x - w0) / len * 100);
    const step = { "15m": 180e3, "1h": 600e3, "6h": 3600e3, Day: 10800e3 }[zoom];
    const ticks = [];
    for (let x = Math.ceil(w0 / step) * step; x < w1; x += step) ticks.push({ l: L(x).toFixed(2) + "%", label: hm(x) });
    const gaps = [];
    let end = T0;
    allReq.forEach((q) => { const d = q.totalMs || 0; if (q.s - end > 240e3) gaps.push([end, q.s]); end = Math.max(end, q.s + d); });
    const gapsV = gaps.filter((gp) => gp[1] > w0 && gp[0] < w1).map((gp) => { const a = Math.max(gp[0], w0), b = Math.min(gp[1], w1), w = L(b) - L(a); return { l: L(a).toFixed(2) + "%", w: w.toFixed(2) + "%", label: w > 4 ? "idle " + Math.round((gp[1] - gp[0]) / 60000) + " min" : "" }; });
    const FAIL = "repeating-linear-gradient(135deg,var(--red) 0 2.5px,transparent 2.5px 5px) var(--redbg)";
    const isFoc = (o) => !fo || (fo.sid ? o.s.session === fo.sid && (!fo.role || o.l.role === fo.role) : true);
    const stStyle = (x) => ({ fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: x[2], color: x[1], whiteSpace: "nowrap" });
    const pos = (li, q) => { const left = Math.max(0, (q.s - w0) / len * 100); return { top: ((li + 1) * 39 + 2) + "px", left: "min(" + left.toFixed(2) + "%, calc(100% - 300px))" }; };
    const lanes = laneList.map((o, li) => {
      const fl = isFoc(o);
      const byModel = {};
      (o.l.requests || []).forEach((q) => { byModel[q.model] = (byModel[q.model] || 0) + 1; });
      const dom = Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]?.[0] || o.l.role;
      const bars = [];
      (o.l.requests || []).forEach((q, ri) => {
        const qs = Date.parse(q.ts);
        const d = q.totalMs || 0;
        if (!Number.isFinite(qs) || qs + d < w0 || qs > w1) return;
        const dim = fo && fo.model ? (o.s.session === fo.sid && o.l.role === fo.role && q.model === fo.model ? 1 : 0.25) : 1;
        const picked = ui.pick && ui.pick.li === li && ui.pick.ri === ri;
        const okQ = String(q.status ?? "ok") === "ok";
        bars.push({
          style: { position: "absolute", top: 9, height: 20, left: L(qs).toFixed(3) + "%", width: Math.max(0, L(qs + d) - L(qs)).toFixed(3) + "%", minWidth: 3, padding: 0, borderRadius: 3, boxSizing: "border-box", cursor: "pointer", opacity: dim,
            border: okQ ? 0 : "1px solid var(--red)", background: !okQ ? FAIL : mc(q.model),
            outline: picked ? "2px solid var(--tx)" : "none", outlineOffset: 1, zIndex: picked ? 2 : 1 },
          aria: o.l.role + ", " + q.model + ", " + hms(q.ts) + ", " + (okQ ? fs((q.totalMs || 0) / 1000) : "failed"),
          hover: () => act.hover?.({ li, ri }), pick: () => act.pick?.({ li, ri }),
        });
      });
      return { role: o.l.role, chip: chip(o.l.role), model: dom, kidId: "s·" + o.s.session, kid: false, op: fl ? 1 : 0.35, bars, tip: o.l.role + " · " + dom, focus: () => act.focus?.({ sid: o.s.session, role: o.l.role }) };
    });
    const at = (sel) => sel && laneList[sel.li] ? laneList[sel.li].l.requests[sel.ri] : null;
    const hovQ = at(ui.hov), pkQ = at(ui.pick);
    const hovO = ui.hov && laneList[ui.hov.li] ? laneList[ui.hov.li] : null;
    const pkO = ui.pick && laneList[ui.pick.li] ? laneList[ui.pick.li] : null;
    const reqFacts = (q) => [["Start", hms(q.ts) + " IST"], ["TTFT", q.ttftMs == null ? "—" : fs(q.ttftMs / 1000)], ["Total", q.totalMs == null ? "—" : fs(q.totalMs / 1000)], ["Tokens in / out", cnt(q.promptTokens || 0) + " / " + cnt(q.completionTokens || 0)], ["Value", usd(q.value || 0), "var(--violet)"]];
    const legend = [...new Set(allReq.map((q) => q.model))].map((m) => ({ m, c: mc(m) }));
    const S2 = allReq.reduce((a, q) => ({ req: a.req + 1, v: a.v + (q.value || 0) }), { req: 0, v: 0 });
    const tok2 = allReq.reduce((a, q) => a + (q.promptTokens || 0) + (q.completionTokens || 0), 0);
    const err2 = allReq.filter((q) => String(q.status ?? "ok") !== "ok").length;
    const liveDet = Number.isFinite(Date.parse(det.lastTs)) && now - Date.parse(det.lastTs) < 5 * 60 * 1000;
    g = {
      lanes, ticks, gaps: gapsV, legend,
      window: hm(w0) + " – " + hm(w1) + " IST · " + zoom + " view",
      now: liveDet && now >= w0 && now <= w1, nowL: L(now).toFixed(2) + "%",
      zooms: ["15m", "1h", "6h", "Day"].map((k) => ({ label: k, on2: zoom === k, style: seg(zoom === k), on: () => act.zoom?.(k) })),
      noPrev: !canPan, noNext: !canPan || !(ui.gOff > 0),
      prev: () => act.pan?.(1), next: () => act.pan?.(-1),
      prevStyle: { width: 28, height: 28, border: "1px solid var(--line2)", borderRadius: 7, background: "var(--card)", color: "var(--tx2)", cursor: "pointer", fontFamily: "'Material Symbols Outlined'", fontSize: 18, opacity: !canPan ? 0.4 : 1 },
      nextStyle: { width: 28, height: 28, border: "1px solid var(--line2)", borderRadius: 7, background: "var(--card)", color: "var(--tx2)", cursor: "pointer", fontFamily: "'Material Symbols Outlined'", fontSize: 18, opacity: !canPan || !(ui.gOff > 0) ? 0.4 : 1 },
      hov: hovQ ? { ...pos(ui.hov.li, { ...hovQ, s: Date.parse(hovQ.ts) }), model: hovQ.model, prov: prov(hovQ.model) + " · " + hovO.l.role, status: statusOf(hovQ)[0], stStyle: stStyle(statusOf(hovQ)), facts: reqFacts(hovQ).map((f) => ({ l: f[0], v: f[1], c: f[2] || "var(--tx)" })) } : null,
      pick: pkQ ? { ...pos(ui.pick.li, { ...pkQ, s: Date.parse(pkQ.ts) }), model: pkQ.model, status: statusOf(pkQ)[0], stStyle: stStyle(statusOf(pkQ)), rid: "r·" + pkO.s.session + "·" + String(ui.pick.ri + 1).padStart(4, "0"),
        facts: [["Provider", prov(pkQ.model)], ["Role", pkO.l.role + (pkQ.combo ? " · " + pkQ.combo : "")], ["Session", "s·" + pkO.s.session, 0, "mono"], ["Started", hms(pkQ.ts) + " IST"], ["TTFT", pkQ.ttftMs == null ? "—" : fs(pkQ.ttftMs / 1000)], ["Total", pkQ.totalMs == null ? "—" : fs(pkQ.totalMs / 1000)], ["Tokens in", cnt(pkQ.promptTokens || 0)], ["Tokens out", cnt(pkQ.completionTokens || 0)], ["Value", usd(pkQ.value || 0), "var(--violet)"], ["Real spend", "—", "var(--tx3)"]]
          .map((f) => ({ l: f[0], v: f[1], c: f[2] || "var(--tx)", ff: f[3] === "mono" ? "var(--mono)" : "inherit" })) } : null,
      note: "Bars coloured by model. Hover for timing, click for request metadata. Latency shows — for rows logged before Nov 9.",
    };
    sm = {
      id: "s·" + det.session, client: det.client || "Unknown", live: liveDet,
      when: (Number.isFinite(Date.parse(det.firstTs)) ? dayLabel(det.firstTs) + ", " + hm(det.firstTs) : "") + " – " + (liveDet ? "now" : (Number.isFinite(Date.parse(det.lastTs)) ? hm(det.lastTs) : "")) + " IST",
      route: call(act.openDrawer, det.session),
      stats: [["Duration", durF(spanS), liveDet ? "still running" : "ended"], ["Agents", String(laneList.length), laneList.length > 1 ? (laneList.length - 1) + " subagents" : "main only"], ["Requests", S2.req.toLocaleString("en-US"), err2 + " failed"], ["Tokens", cnt(tok2), "in + out"], ["Value", usd(S2.v), "list price", "var(--violet)"], ["Success", (S2.req ? (100 - err2 / S2.req * 100) : 100).toFixed(1) + "%", "of finished requests", err2 / Math.max(1, S2.req) > 0.05 ? "var(--red)" : "var(--tx)"]]
        .map((x) => ({ l: x[0], v: x[1], s: x[2], c: x[3] || "var(--tx)" })), models: legend,
    };
  }

  // ---------- roles ----------
  const byRole = analytics?.byRole || [];
  const modelByRole = analytics?.modelByRole || [];
  const orderRoles = [...ROLE_ORDER.filter((r) => byRole.some((x) => x.role === r)), ...byRole.map((x) => x.role).filter((r) => !ROLE_ORDER.includes(r))];
  const TR = byRole.reduce((a, x) => a + (x.requests || 0), 0) || 1;
  const TT = byRole.reduce((a, x) => a + (x.tokens || 0), 0) || 1;
  const TV = byRole.reduce((a, x) => a + (x.value || 0), 0) || 1;
  const p1 = (x) => (x * 100 < 1 && x > 0 ? "<1" : (x * 100).toFixed(0)) + "%";
  const BAR = { main: "var(--tx2)", implementer: "var(--violet)", scout: "var(--blue)", reviewer: "var(--green)", thinker: "var(--amber)", background: "var(--mbar)" };
  const barC = (r) => BAR[r] || "var(--mbar)";
  const share = [["Requests", "requests", TR, cnt(TR), "var(--tx)"], ["Tokens", "tokens", TT, cnt(TT), "var(--tx)"], ["Value", "value", TV, usd(TV), "var(--violet)"]].map(([label, k, tot, total, c]) => ({ label, total, c,
    aria: label + " by role: " + orderRoles.map((r) => { const x = byRole.find((y) => y.role === r); return r + " " + p1((x?.[k] || 0) / tot); }).join(", "),
    segs: orderRoles.map((r) => { const x = byRole.find((y) => y.role === r); return { f: (((x?.[k] || 0) / tot) * 1000).toFixed(0), c: barC(r), t: r + " · " + p1((x?.[k] || 0) / tot) }; }).filter((s) => +s.f > 0) }));
  const legendR = orderRoles.map((r) => { const x = byRole.find((y) => y.role === r) || {}; return { role: r, chip: chip(r), c: barC(r), req: p1((x.requests || 0) / TR), tok: p1((x.tokens || 0) / TT), val: p1((x.value || 0) / TV) }; });
  const deleg = analytics ? analytics.delegationRate : null;
  const cps = analytics ? analytics.childrenPerSession : null;
  const bgReq = (byRole.find((x) => x.role === "background")?.requests || 0) / TR;
  const bgVal = (byRole.find((x) => x.role === "background")?.value || 0) / TV;
  const roCards = [
    ["DELEGATION RATE", deleg == null ? "—" : (deleg * 100).toFixed(0) + "%", byRole.length ? "of sessions delegate" : "no sessions", "Share of sessions that start at least one subagent or delegated child.", "var(--violet)"],
    ["CHILDREN PER SESSION", cps == null ? "—" : cps.toFixed(1), "across sessions in range", "Average subagents and T3 delegated children per session. T3 links are inferred.", "var(--blue)"],
    ["BACKGROUND SHARE", p1(bgReq), "of requests · " + p1(bgVal) + " of value", "Claude Code Haiku jobs: titles, summaries, WebSearch. Not subagents.", "var(--tx3)"],
  ].map(([label, value, sub, tip, dot]) => ({ label, value, sub, tip, dot }));
  const maxTps = Math.max(1, ...modelByRole.map((m) => m.tpsP50 || 0));
  const roRows = [];
  orderRoles.forEach((role) => {
    const rows = modelByRole.filter((m) => m.role === role);
    const elig = rows.filter((m) => (m.samples || 0) >= 50 || (m.requests || 0) >= 50);
    const fast = elig.length > 1 ? elig.reduce((a, b) => (b.tpsP50 || 0) > (a.tpsP50 || 0) ? b : a)[0] : null;
    const rel = elig.length > 1 ? elig.reduce((a, b) => (b.successRate || 0) > (a.successRate || 0) ? b : a)[0] : null;
    roRows.push({ head: true, row: false, role, chip: chip(role), desc: (ROLEDESC[role] || "combo") + " · " + cnt(rows.reduce((a, m) => a + (m.requests || 0), 0)) + " requests" });
    rows.forEach((m) => {
      const sc = (m.successRate ?? 1) * 100;
      const sC = sc >= 98 ? "var(--green)" : sc >= 95 ? "var(--amber)" : "var(--red)";
      roRows.push({ head: false, row: true, model: m.model || "unknown", mc: mc(m.model), prov: prov(m.model), req: cnt(m.requests || 0),
        tps: m.tpsP50 != null ? String(Math.round(m.tpsP50)) : "—", tpsW: ((m.tpsP50 || 0) / maxTps * 100).toFixed(0) + "%",
        ttft: m.ttftP50 != null ? (m.ttftP50 / 1000).toFixed(1) + " s" : "—",
        lat: (m.totalP50 != null ? (m.totalP50 / 1000).toFixed(1) : "—") + " / " + (m.totalP95 != null ? (m.totalP95 / 1000).toFixed(1) : "—") + " s",
        succ: sc.toFixed(1) + "%", sW: Math.max(4, (sc - 85) / 15 * 100).toFixed(0) + "%", sC,
        vpr: (m.requests && m.value != null) ? ((m.value / m.requests) < 0.01 && m.value > 0 ? "<$0.01" : "$" + (m.value / m.requests).toFixed(2)) : "$0.00",
        samples: cnt(m.samples || 0), fast: fast && m.model === fast.model, rel: rel && m.model === rel.model });
    });
  });
  const ro = { share, legend: legendR, cards: roCards, rows: roRows,
    fastChip: { display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10.5, fontWeight: 600, padding: "0 6px", height: 18, borderRadius: 4, background: "var(--bluebg)", color: "var(--chipscout)", whiteSpace: "nowrap", flex: "none" },
    relChip: { display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10.5, fontWeight: 600, padding: "0 6px", height: 18, borderRadius: 4, background: "var(--greenbg)", color: "var(--chiprev)", whiteSpace: "nowrap", flex: "none" },
    note: "TPS = output tokens per second after the first token. Value per request at API list price (estimate). Samples = requests with latency logged; rows logged before Nov 9 show —. thinker is fusion: every member answers each call." };

  // ---------- tools ----------
  const toolRole = ui.toolRole || "";
  const toolData = tools?.tools || [];
  const toolRoles = [...new Set(toolData.flatMap((t) => (t.byRole || []).map((r) => r.role)))].sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a), bi = ROLE_ORDER.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
  });
  const toolRows = toolData.map((t) => {
    const roles = (t.byRole || []).filter((r) => !toolRole || r.role === toolRole);
    const calls = toolRole ? roles.reduce((n, r) => n + r.calls, 0) : t.calls;
    const errors = toolRole ? roles.reduce((n, r) => n + r.errors, 0) : t.errors;
    return { name: t.name, calls, errors, pct: (calls ? errors / calls * 100 : 0).toFixed(1) + "%",
      topModel: t.topModel?.model || "—", split: roles.map((r) => ({ role: r.role, calls: r.calls, c: barC(r.role), f: calls ? r.calls / calls * 100 : 0 })) };
  }).filter((t) => t.calls > 0).sort((a, b) => b.calls - a.calls);
  const tl = { rows: toolRows, none: toolRows.length === 0, hasData: toolData.length > 0, emptyTitle: "Tool tracking started Nov 9, 2026",
    roleBtns: ["", ...toolRoles].map((role) => ({ label: role || "All", on2: role === toolRole, style: seg(role === toolRole), on: call(act.setToolRole, role) })),
    perRole: (tools?.topToolsByRole || []).map((r) => ({ role: r.role, chip: chip(r.role), c: barC(r.role), items: (r.tools || []).map((t) => ({ ...t, w: ((t.calls / (r.tools[0]?.calls || 1)) * 100).toFixed(0) + "%" })) })),
    sampleNote: tools?.sampled ? `Sampled ${cnt(tools.sampled.rows)} rows (limit ${cnt(tools.sampled.cap)}).${tools.truncated ? " Results are truncated." : ""}` : tools?.truncated ? "Results are truncated." : "",
    note: "Calls counted per tool use. Errors are tool results marked as errors." };

  // ---------- page state ----------
  const v = { live: false, sess: false, roles: false, tools: false, loading: mode === "loading", error: mode === "error", empty: false, stale: mode === "stale", partial: false, dim: mode === "stale" ? 0.6 : 1 };
  v.loadingText = { live: "Connecting to the live feed…", sessions: "Reading sessions and request timings…", roles: "Aggregating " + rangeTitle.toLowerCase() + " by role and model…", tools: "Counting tool calls…" }[tab];
  v.errTitle = tab === "live" ? "Live feed unavailable" : "Couldn't load " + tab;
  v.errBody = ui.errorText || "The request failed. Spend and Usage are unaffected.";
  v.staleText = tab === "live" ? "Live data may be out of date. Retrying every 2 s." : "Data may be out of date. Requests after the last refresh are not included yet.";
  if (ok) {
    if (tab === "live") v.live = mode === "stale" || liveCards.length > 0;
    else if (tab === "sessions") v.sess = sessList.length > 0;
    else if (tab === "roles") v.roles = byRole.length > 0;
    else if (tab === "tools") v.tools = false;
  }
  if (mode === "empty" || (ok && tab === "live" && !liveCards.length)) v.empty = true;
  if (v.empty) {
    if (tab === "live") Object.assign(v, { emptyIcon: "bedtime", emptyTitle: "No sessions in the last 5 minutes", emptyBody: "Start a request from Claude Code, Codex, OpenCode or T3 Code and it will show up here.", emptyBtn: "Open Sessions", emptyGo: () => act.openTimeline?.(null) });
    else if (tab === "tools") Object.assign(v, { emptyIcon: "construction", emptyTitle: "Tool telemetry is not available yet", emptyBody: "The /api/agents/tools endpoint is not built. Tool names only are recorded once it lands.", emptyBtn: "Show last 7 days", emptyGo: () => act.setPreset?.("7D") });
    else Object.assign(v, { emptyIcon: "smart_toy", emptyTitle: "No sessions in this range", emptyBody: "9Router logged no agent requests in " + rangeTitle.toLowerCase() + ". Background jobs and home apps are not sessions.", emptyBtn: "Show last 7 days", emptyGo: () => act.setPreset?.("7D") });
  }
  if ((v.sess || v.roles) && preset !== "Today" && preset !== "24h") { v.partial = true; v.partialText = "Sessions and roles logged since Nov 7. Latency and failures logged since Nov 9, so samples are lower than requests."; }

  // ---------- status pill / tabs / freshness ----------
  const status = mode === "error" ? { text: "Not tracking · " + (ui.errorText || "request failed"), c: "var(--red)", bg: "var(--redbg)" }
    : mode === "stale" ? { text: "Stale · " + topLevel.length + " sessions live", c: "var(--amber)", bg: "var(--amberbg)" }
    : mode === "empty" || !topLevel.length ? { text: "No live sessions", c: "var(--tx2)", bg: "var(--seg)" }
    : mode === "loading" ? { text: "Connecting…", c: "var(--tx2)", bg: "var(--seg)" }
    : { text: topLevel.length + " sessions live", c: "var(--green)", bg: "var(--greenbg)" };
  const liveDot = (mode === "ready" || mode === "stale") && topLevel.length ? { width: 8, height: 8, borderRadius: "50%", background: "var(--green)", animation: ui.paused ? "none" : "r9pulse 1.6s infinite" } : null;
  const sessCount = tab === "sessions" && (totalSessions ?? sessList.length) ? String(totalSessions ?? sessList.length) : "";
  const tabs = [["live", "Live", (mode === "ready" || mode === "stale") && topLevel.length ? String(topLevel.length) : "", liveDot], ["sessions", "Sessions", sessCount, ""], ["roles", "Roles", ""], ["tools", "Tools", ""]]
    .map(([k, label, count, dot]) => ({ label, count: count || "", dot: dot || null, on: () => act.tab?.(k), style: { ...seg(tab === k), height: 32, padding: "0 12px", fontSize: 13, display: "flex", alignItems: "center", gap: 8, background: tab === k ? "var(--card)" : "transparent", boxShadow: tab === k ? "0 0 0 1px var(--line2)" : "none" } }));
  const fresh = mode === "stale" ? { text: "Stale · retrying", c: "var(--amber)", dot: { width: 8, height: 8, borderRadius: "50%", background: "var(--amber)" }, icon: "pause", btn: "Pause" }
    : mode === "error" ? { text: "Feed closed", c: "var(--red)", dot: { width: 8, height: 8, borderRadius: "50%", background: "var(--red)" }, icon: "pause", btn: "Pause" }
    : ui.paused ? { text: "Paused · updated " + (ui.ago || 0) + " s ago", c: "var(--tx2)", dot: { width: 8, height: 8, borderRadius: "50%", border: "1.5px solid var(--tx3)", boxSizing: "border-box" }, icon: "play_arrow", btn: "Resume" }
    : { text: (ui.ago || 0) === 0 ? "Updated just now" : "Updated " + (ui.ago || 0) + " s ago", c: "var(--tx2)", dot: { width: 8, height: 8, borderRadius: "50%", background: "var(--green)", animation: mode === "ready" ? "r9pulse 1.6s infinite" : "none" }, icon: "pause", btn: "Pause" };

  // ---------- routing drawer ----------
  let dr = null;
  const dId = ui.drawer;
  const dLive = dId && liveSessions.find((s) => s.session === dId);
  const dDet = dId && det && det.session === dId ? det : null;
  const dRoles = dLive ? (dLive.roles || []) : dDet ? (dDet.agents || []).map((a) => ({ role: a.role, model: latestModel(a) })) : [];
  if (dId && dRoles.length) {
    const sessionOverrides = overrides || [];
    const isCodex = (dLive?.client || dDet?.client) === "Codex";
    const modelId = (m) => typeof m === "string" ? m : m?.fullModel || m?.routedModel || m?.id || m?.model || "";
    const available = models.map(modelId).filter(Boolean).filter((m) => !isCodex || /^(openai\/|gpt-|codex)/i.test(m));
    const changed = [];
    dr = {
      sid: "s·" + dId, client: (dLive?.client || dDet?.client) || "Unknown", started: dLive && Number.isFinite(Date.parse(dLive.lastTs)) ? hm(dLive.lastTs) : (dDet ? dayLabel(dDet.firstTs) + " " + hm(dDet.firstTs) : "—"),
      aria: "Change routing for s·" + dId, w: vw < 900 ? "100vw" : "520px",
      rows: dRoles.map((r) => {
        const role = r.role, current = r.model || "unknown", entry = sessionOverrides.find((e) => e.combo === role), locked = role === "thinker" || role === "background";
        const edit = draft[role] || {};
        const members = combos.find((c) => c.name === role)?.models || [current];
        const memberIds = members.map(modelId).filter(Boolean);
        const otherKey = "__other__";
        const selected = edit.sel ?? (memberIds.includes(entry?.model) ? entry.model : entry ? otherKey : memberIds.includes(current) ? current : otherKey);
        const target = selected === otherKey ? edit.other || entry?.model || available[0] || "" : selected;
        const modeValue = edit.mode || (entry?.mode === "override" ? "override" : "member");
        const expiry = edit.expiry || (entry?.expiry === "1h" || entry?.expiry === "2h" ? entry.expiry : "Session end");
        const expiryValue = expiry === "Session end" ? "session" : expiry;
        const currentExpiry = entry?.expiry || "session";
        const dirty = !locked && !!target && (target !== current || modeValue !== (entry?.mode || "member") || expiryValue !== currentExpiry);
        if (dirty) changed.push({ role, from: current, to: target, mode: modeValue, expiry });
        const options = [...new Set([...memberIds, ...(memberIds.includes(current) ? [] : [current]), otherKey])].map((id) => ({ v: id, label: id === otherKey ? "Other model…" : id === current ? id + "  (current)" : id }));
        const otherOpts = [...new Set([...available, ...(entry?.model && !available.includes(entry.model) ? [entry.model] : [])])].map((id) => ({ v: id, label: id }));
        const status = entry ? entry.status === "pending" ? "Pending · next request" : "Active · until " + (entry.expiry === "1h" ? "1 hour" : entry.expiry === "2h" ? "2 hours" : "session end") : "";
        return { role, chip: chip(role), cur: entry?.status === "active" ? entry.model : current, locked,
        lockText: role === "thinker" ? "thinker is fusion and cannot be overridden." : "Not routed by a combo. Fixed to claude-haiku-5-5 by Claude Code.",
        editable: !locked, status, statusStyle: { fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 5, background: entry?.status === "pending" ? "var(--amberbg)" : "var(--greenbg)", color: entry?.status === "pending" ? "var(--amber)" : "var(--green)" }, canRevert: !!entry, revert: () => act.revertOverride?.(dId, role, revisions[role] ?? revisions[entry?.combo] ?? entry?.revision, entry),
        rowStyle: { display: "flex", flexDirection: "column", gap: 10, padding: "14px 0", borderTop: "1px solid var(--line)" },
        sel: selected, opts: options, onSel: (e) => setDraft({ [role]: { ...edit, sel: e.target.value } }), isOther: selected === otherKey, other: edit.other || entry?.model || available[0] || "", otherOpts, onOther: (e) => setDraft({ [role]: { ...edit, other: e.target.value } }),
        warn: /opus|fable/i.test(target) ? "This model can cost much more per request. Confirm before applying." : "",
        modeAria: "Mode for " + role, modes: ["member", "override"].map((m) => ({ label: m === "member" ? "Combo member" : "Override", on2: modeValue === m, tip: m === "member" ? "Use this model as the combo member for this session." : "Route this role directly to this model.", style: seg(modeValue === m), on: () => setDraft({ [role]: { ...edit, mode: m } }) })), strict: modeValue === "override", expiry, onExp: (e) => setDraft({ [role]: { ...edit, expiry: e.target.value } }) };
      }),
      audit: [], noAudit: true,
      noChanges: changed.length === 0, changeText: changed.length ? changed.length + (changed.length === 1 ? " role changed" : " roles changed") : "No changes",
      applyStyle: { height: 32, padding: "0 16px", borderRadius: 8, border: 0, background: "var(--acc)", color: "#fff", font: "inherit", fontSize: 12.5, fontWeight: 600, cursor: changed.length ? "pointer" : "default", opacity: changed.length ? 1 : 0.45 },
      apply: () => changed.length && setCf(true), changes: changed,
    };
  }

  const sk = (ws, ps) => ws.map((w, i) => ({ w: w + "px", wb: (60 + (i * 13) % 40) + "%", p: (ps ? ps[i] : 0) + "px" }));
  return {
    status, tabs, fresh, paused: !!ui.paused, togglePause: () => act.pause?.(),
    isLiveTab: tab === "live", notLiveTab: tab !== "live", isSessTab: tab === "sessions", isTableTab: tab === "roles" || tab === "tools",
    preset, customLabel: range?.label || "", rangeTitle,
    v, live: { kpis, cards: liveCards }, tree, g, sm, ro, dl: null,
    dlNote: "Per-day delegation history is not available from /api/agents/analytics yet.",
    tl, liveWide: vw >= 900, liveNarrow: vw < 900,
    lay: vw >= 1180 ? { tf: "0 0 calc(44% - 8px)", tmax: "calc(44% - 8px)", rf: "1 1 0" } : { tf: "1 1 100%", tmax: "100%", rf: "1 1 100%" },
    unhover: () => act.hover?.(null), closePick: () => act.pick?.(null),
    dr, closeDrawer: () => act.openDrawer?.(null), cm: cf && dr ? { title: "Apply routing changes to " + dr.sid + "?", lines: dr.changes.map((c) => ({ ...c, chip: chip(c.role), from: short(c.from), to: short(c.to), exp: c.expiry, mode: c.mode })) } : null, cancelCf: () => setCf(false), doCf: () => { setCf(false); act.applyOverrides?.(dId, dr?.changes || []); },
    toast, closeToast: () => setToast(null),
    retry: () => act.retry?.(),
    skel2: [{}, {}], skel4: sk([180, 220, 160, 200]), skel6: sk([140, 120, 160, 130, 150, 110]), skel8: sk([120, 70, 90, 80, 130, 70, 100, 90], [0, 22, 40, 40, 0, 22, 0, 0]),
  };
}

function kidOfAll(list) { const tops = new Set(list.filter((s) => !s.parent).map((s) => s.session)); return list.filter((s) => s.parent && tops.has(s.parent.session || s.parent)).length; }
function latestModel(a) { const rs = a.requests || []; return rs.length ? rs[rs.length - 1].model : null; }
