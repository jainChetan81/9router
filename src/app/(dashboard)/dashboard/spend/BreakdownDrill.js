"use client";

// Breakdown, ported from Spend.dc.html (round 2): Group by, Share by, tokens split, provider -> model -> effort drill-down.
// Rows come from /api/spend: providerTree for Provider, the existing groups for every other grouping.
import { useState } from "react";
import { fN, fP, fR, fT, fV, fVpr, sum } from "@/lib/spend/uiHelpers";
import useWidth from "./useWidth";
import { fmtFee } from "./view";

const MS = { fontFamily: "'Material Symbols Outlined'", lineHeight: 1 };
const SPC = ["var(--tx)", "var(--blue)", "var(--amber)", "var(--green)"], SPN = ["Uncached input", "Cache read", "Cache write", "Output"];
const SPK = ["input", "cacheRead", "cacheWrite", "output"];
const OPS = [1, 0.72, 0.5, 0.34, 0.22, 0.14, 0.1];
const PROV = { claude: "Claude Code", codex: "OpenAI Codex", antigravity: "Antigravity", "opencode-go": "OpenCode Go", muse: "Muse", openrouter: "OpenRouter", deepseek: "DeepSeek", "ollama-local": "Ollama", ollama: "Ollama", opencode: "OpenCode Free" };
const DESC = { claude: "Subscription", codex: "Subscription", antigravity: "Subscription", "opencode-go": "Subscription", muse: "Subscription", openrouter: "Pay per token", deepseek: "Pay per token · prepaid", "ollama-local": "Local · free", ollama: "Local · free", opencode: "Free tier" };
const GROUPS = [["key", "API key"], ["model", "Model"], ["modelEffort", "Model + effort"], ["role", "Combo/Role"], ["client", "Client"], ["session", "Session"], ["provider", "Provider"]];
const GH = { key: "API key", model: "Model", modelEffort: "Model + effort", role: "Combo / role", client: "Client", session: "Session", provider: "Provider" };
const MH = { value: "Share of value", real: "Share of real spend", req: "Share of requests", tok: "Share of tokens" };
const TIP = {
  value: "This row's list-price value as a percent of all value in the range. Not quota used.",
  real: "This row's real spend as a percent of all real spend in the range. The hatched part used list price because the provider reported no cost.",
  req: "This row's requests as a percent of all requests in the range. Not quota used.",
  tok: "This row's tokens as a percent of all tokens in the range. Not quota used.",
};
const segStyle = (on) => ({ border: "0", height: "26px", padding: "0 10px", borderRadius: "7px", fontSize: "12px", whiteSpace: "nowrap", cursor: "pointer", background: on ? "var(--segon)" : "transparent", color: on ? "var(--tx)" : "var(--tx2)", fontWeight: on ? 600 : 400, boxShadow: on ? "0 1px 2px rgba(0,0,0,.08)" : "none" });
const STATE = { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", padding: "26px 12px", textAlign: "center", borderTop: "1px solid var(--line)" };
const BTN = { border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", borderRadius: "7px", height: "28px", padding: "0 12px", fontSize: "12px", cursor: "pointer" };

// Normalise an API node to the design's row shape {name, desc, r, t, v, re, es, sp}.
const splitOf = (ts) => { const t = ts ? sum(SPK, (k) => ts[k]) : 0; return t ? SPK.map((k) => ts[k] / t) : null; };
const node = (o, name, desc, extra) => ({ name, desc, r: o.req || 0, t: o.tok || 0, v: o.v || 0, re: o.real > 0 ? o.real : null, es: o.realEst || 0, sp: splitOf(o.tokSplit), ...extra });

export default function BreakdownDrill({ data, state, group, onGroup, onRetry, onShow30, rangeTitle }) {
  const [metric, setMetric] = useState("value");
  const [split, setSplit] = useState(false);
  const [tip, setTip] = useState(false);
  const [exp, setExp] = useState({});
  const [ref, w] = useWidth();
  const wide = w >= 640;

  const mv = (o) => (metric === "value" ? o.v : metric === "real" ? o.re : metric === "req" ? o.r : o.t);
  const sortM = (a) => a.slice().sort((x, y) => (mv(y) ?? -1) - (mv(x) ?? -1) || y.v - x.v);
  const fMetric = (v) => (v == null ? "—" : metric === "value" ? fV(v) : metric === "real" ? fR(v) : metric === "req" ? fN(v) : fT(v));
  const toggle = (k) => () => setExp((e) => ({ ...e, [k]: !e[k] }));
  const tokSplit = data?.groups?.tokenSplit || {};

  const mkRow = (o, denom, depth, opt = {}) => {
    const m = mv(o), has = m != null && denom > 0, sh = has ? (m / denom) * 100 : 0;
    const w1 = metric === "real" && has ? ((o.re - (o.es || 0)) / denom) * 100 : sh, w2 = metric === "real" && has ? ((o.es || 0) / denom) * 100 : 0;
    let mix = null, mixTitle = "";
    if (opt.mix) { const tm = sum(opt.mix, (x) => x.val) || 1; mix = opt.mix.map((x, i) => ({ w: (x.val / tm) * 100 + "%", op: OPS[Math.min(i, OPS.length - 1)] })); mixTitle = opt.mix.map((x) => x.n + " " + fP((x.val / tm) * 100)).join(" · "); }
    const sp = o.sp;
    return {
      key: opt.key || o.name, isRow: true, name: o.name, desc: o.desc || "", font: opt.mono ? "var(--mono)" : "inherit", fs: opt.mono ? "12.5px" : "13px", fw: opt.mono ? 400 : 600, nameColor: opt.muted ? "var(--tx3)" : "var(--tx)",
      pad: depth * 20 + "px", bg: depth ? "var(--bg)" : "transparent", chev: opt.open ? "expand_more" : "chevron_right", chevVis: opt.toggle ? "visible" : "hidden", cursor: opt.toggle ? "pointer" : "default", onToggle: opt.toggle || undefined, open: !!opt.open,
      mix, mixTitle, req: fN(o.r), tok: fT(o.t), real: opt.muted ? "not logged" : fR(o.re), realColor: o.re && !opt.muted ? "var(--acc)" : "var(--tx3)", realFw: o.re && !opt.muted ? 600 : 400, hasEst: (o.es || 0) >= 0.005, est: fR(o.es),
      value: fV(o.v), vpr: o.r ? fVpr(o.v / o.r) + " / req" : "—",
      split: sp ? sp.map((x, i) => ({ w: x * 100 + "%", c: SPC[i] })) : [], splitTitle: sp ? sp.map((x, i) => SPN[i] + " " + Math.round(x * 100) + "%").join(" · ") : "Token split not recorded",
      shareLabel: has ? fP(sh) : "—", w1: w1 + "%", w2: w2 + "%", metricVal: fMetric(m),
    };
  };
  const subRow = (label, depth) => ({ key: "sub:" + label, isSub: true, label, subPad: depth * 20 + 29 + "px" });

  const rows = [];
  if (data) {
    const G = data.groups;
    if (group === "provider") {
      const feeKey = Object.fromEntries((data.subsMeta || []).map((m) => [m.provider, m.k]));
      const fee = (k) => { const f = data.fees?.[feeKey[k]]; return f !== null && f !== undefined && f !== "" ? " · " + fmtFee(f) + "/mo" : ""; };
      const tree = (G.providerTree || []).map((p) => node(p, PROV[p.k] || p.k, (DESC[p.k] || "Provider") + (feeKey[p.k] ? fee(p.k) : ""), {
        id: p.k, models: (p.models || []).map((m) => node(m, m.k, "", { efforts: (m.efforts || []).map((e) => node(e, e.k, "")) })),
      }));
      const den = sum(tree, mv);
      sortM(tree).forEach((p) => {
        const open = !!exp[p.id];
        rows.push(mkRow(p, den, 0, { key: p.id, toggle: toggle(p.id), open, mix: sortM(p.models).map((x) => ({ n: x.name, val: mv(x) ?? x.v })) }));
        if (!open) return;
        rows.push(subRow("Models in " + p.name + " · share within provider", 1));
        const pd = mv(p);
        sortM(p.models).forEach((md) => {
          const k = p.id + "|" + md.name, canOpen = md.efforts.length > 1 || (md.efforts.length === 1 && md.efforts[0].name !== "Unknown");
          const mo = !!exp[k] && canOpen;
          rows.push(mkRow(md, pd, 1, { key: k, mono: true, toggle: canOpen ? toggle(k) : null, open: mo }));
          if (!mo) return;
          rows.push(subRow("Effort for " + md.name + " · share within model", 2));
          const ed = mv(md);
          sortM(md.efforts).forEach((e) => rows.push(mkRow(e, ed, 2, { key: k + "|" + e.name, mono: true })));
        });
      });
    } else {
      const T = data.totals || {};
      let items = [];
      const mixOf = (o) => { const m = (o.mix || []).filter((e) => e[1] > 0); return m.length > 1 ? m.map(([n, v]) => ({ n, val: v })) : null; };
      if (group === "key") items = (G.key || []).map((o) => node(o, o.k, o.clients?.length ? o.clients.join(", ") : "Client not recorded", { mono: true }));
      else if (group === "model") items = (G.model || []).map((o) => node(o, o.k, [PROV[o.provider] || o.provider, ...(o.clients || [])].join(" · "), { mono: true, sp: splitOf(tokSplit[o.k]) }));
      else if (group === "modelEffort") items = (G.modelEffort || []).map((o) => node(o, o.model + " · " + o.effort, "Effort: " + o.effort, { mono: true }));
      else if (group === "role") items = (G.role || []).map((o) => node(o, o.k, (o.k === "main" ? "No combo" : "Combo or direct model") + " · " + (data.roleCount?.[o.k] || 0) + " sessions", { mono: true, mixArr: mixOf(o) }));
      else if (group === "client") items = (G.client || []).map((o) => node(o, o.k, (o.mix || []).slice(0, 3).map((e) => e[0]).join(", "), { mixArr: mixOf(o) }));
      else if (group === "session") {
        items = (data.sessions || []).slice(0, 10).map((x) => node(x, "s·" + x.id, x.client + " · " + x.role, { mono: true }));
        if ((data.sessionCount || 0) > 10 && data.sessionRest10) items.push(node(data.sessionRest10, fN(data.sessionCount - 10) + " other sessions", "Below top 10"));
      }
      if (["role", "client", "session"].includes(group) && T.nrReq > 0)
        items.push({ name: "Not recorded", desc: "Before " + (data.loggedSinceLabel || "logging start") + " · logging start", r: T.nrReq, t: T.nrTok || 0, v: T.nrList || 0, re: null, es: 0, sp: null, muted: true });
      const den = sum(items, mv);
      sortM(items).forEach((x, i) => rows.push(mkRow(x, den, 0, { key: group + i + x.name, mono: x.mono, muted: x.muted, mix: x.mixArr })));
    }
  }

  const splitWide = split && wide, splitNarrow = split && !wide;
  const cols = wide ? "minmax(190px,2fr) .75fr .75fr 1fr 1fr .8fr " + (splitWide ? "110px " : "") + "minmax(140px,1.5fr)" : "minmax(0,1fr) 118px";
  const shareColor = metric === "value" ? "var(--violet)" : metric === "real" ? "var(--acc)" : "var(--tx2)";
  const metricColor = metric === "value" ? "var(--violet)" : metric === "real" ? "var(--acc)" : "var(--tx)";
  const live = state === "ready";

  return (
    <section ref={ref} data-screen-label="Breakdown" style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px", minWidth: "0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "8px 16px" }}>
        <span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)", textTransform: "uppercase" }}>Breakdown</span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "0", maxWidth: "100%" }}>
          <span style={{ fontSize: "12px", color: "var(--tx3)", flex: "none" }}>Group by</span>
          <div className="r9-segment" style={{ overflowX: "auto", minWidth: "0" }}><div style={{ display: "flex", gap: "2px", padding: "3px", borderRadius: "9px", background: "var(--seg)", width: "max-content" }}>
            {GROUPS.map(([k, l]) => <button key={k} onClick={() => onGroup(k)} style={segStyle(group === k)}>{l}</button>)}
          </div></div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "8px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "0", maxWidth: "100%" }}>
          <span style={{ fontSize: "12px", color: "var(--tx3)", flex: "none" }}>Share by</span>
          <div className="r9-segment" style={{ overflowX: "auto", minWidth: "0" }}><div style={{ display: "flex", gap: "2px", padding: "3px", borderRadius: "9px", background: "var(--seg)", width: "max-content" }}>
            {[["value", "Value"], ["real", "Real spend"], ["req", "Requests"], ["tok", "Tokens"]].map(([k, l]) => <button key={k} onClick={() => setMetric(k)} style={segStyle(metric === k)}>{l}</button>)}
          </div></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {split && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: "11px", color: "var(--tx3)" }}>
              {SPN.map((n, i) => <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}><span style={{ width: "8px", height: "8px", borderRadius: "2px", background: SPC[i] }}></span>{n}</span>)}
            </div>
          )}
          <div style={{ display: "flex", padding: "3px", borderRadius: "9px", background: "var(--seg)" }}>
            <button onClick={() => setSplit((x) => !x)} style={{ ...segStyle(split), display: "inline-flex", alignItems: "center", gap: "4px" }}><span style={{ ...MS, fontSize: "15px" }}>{split ? "check_box" : "check_box_outline_blank"}</span>Show tokens split</button>
          </div>
        </div>
      </div>

      {live && (<>
        <div style={{ overflowX: "auto", margin: "0 -18px", padding: "0 18px" }}>
          <div style={{ minWidth: wide ? (split ? "980px" : "860px") : "0px", padding: "0 8px" }}>
            <div style={{ display: "grid", gridTemplateColumns: cols, gap: "12px", padding: "6px 8px", margin: "0 -8px", fontSize: "11px", fontWeight: "600", color: "var(--tx3)", letterSpacing: ".04em", textTransform: "uppercase", alignItems: "end" }}>
              <div>{GH[group]}</div>
              {wide && (<>
                <div style={{ textAlign: "right" }}>Requests</div>
                <div style={{ textAlign: "right" }}>Tokens</div>
                <div style={{ textAlign: "right" }}>Real spend</div>
                <div style={{ textAlign: "right" }}>List-price value <span style={{ fontWeight: "500", letterSpacing: "0", textTransform: "none" }}>(est.)</span></div>
                <div style={{ textAlign: "right" }}>Value / req</div>
                {splitWide && <div>Token split</div>}
              </>)}
              <div onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)} style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "4px", cursor: "help" }}>
                <span>{MH[metric]}</span><span style={{ ...MS, fontSize: "14px", textTransform: "none", letterSpacing: "0" }}>info</span>
                {tip && <div style={{ position: "absolute", top: "100%", right: "0", marginTop: "6px", width: "250px", zIndex: "5", background: "var(--card)", border: "1px solid var(--line2)", borderRadius: "8px", padding: "8px 10px", fontSize: "11.5px", fontWeight: "400", letterSpacing: "0", textTransform: "none", color: "var(--tx2)", boxShadow: "0 4px 14px rgba(0,0,0,.1)", textWrap: "pretty" }}>{TIP[metric]}</div>}
              </div>
            </div>
            {rows.map((r) => r.isSub ? (
              <div key={r.key} style={{ padding: `6px 8px 6px ${r.subPad}`, margin: "0 -8px", borderTop: "1px solid var(--line)", background: "var(--bg)", fontSize: "10.5px", fontWeight: "600", letterSpacing: ".04em", color: "var(--tx3)", textTransform: "uppercase" }}>{r.label}</div>
            ) : (
              <div key={r.key} role={r.onToggle ? "button" : undefined} tabIndex={r.onToggle ? 0 : undefined} aria-expanded={r.onToggle ? !!r.open : undefined} onClick={r.onToggle} onKeyDown={r.onToggle ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.onToggle(); } } : undefined} style={{ display: "grid", gridTemplateColumns: cols, gap: "12px", alignItems: "center", padding: "9px 8px", margin: "0 -8px", borderTop: "1px solid var(--line)", background: r.bg, cursor: r.cursor, fontVariantNumeric: "tabular-nums" }}>
                <div style={{ minWidth: "0", display: "flex", gap: "4px", paddingLeft: r.pad }}>
                  <span style={{ ...MS, fontSize: "17px", color: "var(--tx3)", width: "17px", flex: "none", visibility: r.chevVis }}>{r.chev}</span>
                  <div style={{ minWidth: "0", flex: "1" }}>
                    <div style={{ fontFamily: r.font, fontSize: r.fs, fontWeight: r.fw, color: r.nameColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                    <div style={{ fontSize: "11.5px", color: "var(--tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.desc}</div>
                    {r.mix && <div title={r.mixTitle} style={{ display: "flex", gap: "1px", height: "4px", marginTop: "5px", borderRadius: "2px", overflow: "hidden", maxWidth: "220px", background: "var(--seg)" }}>{r.mix.map((s, i) => <div key={i} style={{ width: s.w, background: "var(--violet)", opacity: s.op }}></div>)}</div>}
                    {splitNarrow && <div title={r.splitTitle} style={{ display: "flex", gap: "1px", height: "5px", marginTop: "5px", borderRadius: "2px", overflow: "hidden", maxWidth: "220px", background: "var(--seg)" }}>{r.split.map((s, i) => <div key={i} style={{ width: s.w, background: s.c }}></div>)}</div>}
                  </div>
                </div>
                {wide && (<>
                  <div style={{ textAlign: "right" }}>{r.req}</div>
                  <div style={{ textAlign: "right" }}>{r.tok}</div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ color: r.realColor, fontWeight: r.realFw }}>{r.real}</div>
                    {r.hasEst && <div title="Part of this total uses list price because the provider reported no cost" style={{ fontSize: "10.5px", color: "var(--tx3)", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "4px", whiteSpace: "nowrap" }}><span style={{ width: "8px", height: "8px", borderRadius: "2px", background: "repeating-linear-gradient(135deg,var(--acc) 0 2px,transparent 2px 4px)" }}></span>{r.est} estimated</div>}
                  </div>
                  <div style={{ textAlign: "right", color: "var(--violet)", fontWeight: "500" }}>{r.value}</div>
                  <div style={{ textAlign: "right", fontSize: "11.5px", color: "var(--tx3)" }}>{r.vpr}</div>
                  {splitWide && <div title={r.splitTitle} style={{ display: "flex", gap: "1px", height: "6px", borderRadius: "3px", overflow: "hidden", background: "var(--seg)" }}>{r.split.map((s, i) => <div key={i} style={{ width: s.w, background: s.c }}></div>)}</div>}
                </>)}
                <div style={{ minWidth: "0" }}>
                  {!wide && <div style={{ textAlign: "right", fontSize: "12.5px", fontWeight: "600", color: metricColor, marginBottom: "4px" }}>{r.metricVal}</div>}
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <div style={{ flex: "1", height: "6px", borderRadius: "3px", background: "var(--seg)", overflow: "hidden", display: "flex" }}><div style={{ width: r.w1, background: shareColor }}></div><div style={{ width: r.w2, background: "repeating-linear-gradient(135deg,var(--acc) 0 2px,transparent 2px 4px)" }}></div></div>
                    <span style={{ fontSize: "11.5px", width: "44px", textAlign: "right", color: "var(--tx2)" }}>{r.shareLabel}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ fontSize: "11px", color: "var(--tx3)", textWrap: "pretty" }}>Client, session and combo logged since {data?.loggedSinceLabel || "Nov 6"}. Hatched real spend used list price because the provider reported no cost. Click a provider to see its models, then a model to see effort.</div>
      </>)}
      {state === "loading" && (
        <div>{[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ display: "flex", gap: "14px", alignItems: "center", padding: "13px 0", borderTop: "1px solid var(--line)" }}>
            <div style={{ flex: "2", height: "12px", borderRadius: "4px", background: "var(--seg)" }}></div><div style={{ flex: "1", height: "12px", borderRadius: "4px", background: "var(--seg)" }}></div><div style={{ flex: "1", height: "12px", borderRadius: "4px", background: "var(--seg)" }}></div><div style={{ flex: "1.6", height: "6px", borderRadius: "3px", background: "var(--seg)" }}></div>
          </div>
        ))}</div>
      )}
      {state === "empty" && (
        <div style={STATE}>
          <span style={{ ...MS, fontSize: "24px", color: "var(--tx3)" }}>event_busy</span>
          <div style={{ fontWeight: "600" }}>No calls in this range</div>
          <div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>Nothing was routed during {rangeTitle}.</div>
          <button onClick={onShow30} style={BTN}>Show last 30 days</button>
        </div>
      )}
      {state === "error" && (
        <div style={STATE}>
          <span style={{ ...MS, fontSize: "24px", color: "var(--red)" }}>error</span>
          <div style={{ fontWeight: "600" }}>Couldn&apos;t load breakdown</div>
          <div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>The spend query did not finish.</div>
          <button onClick={onRetry} style={BTN}>Retry</button>
        </div>
      )}
    </section>
  );
}
