"use client";

// Routing map, ported from Spend.dc.html (round 2): combo -> provider -> model Sankey, grouped list on narrow widths.
// Links come from /api/spend groups.routes (combo->provider and provider->model edges, logged rows only).
import { useMemo, useRef, useState } from "react";
import { fLoc, fN, fR, fV, mapRoutes, sankeyLayout, sum, topPaidRoute } from "@/lib/spend/uiHelpers";
import useWidth from "./useWidth";

const MS = { fontFamily: "'Material Symbols Outlined'", lineHeight: 1 };
const CHIP = { main: ["var(--seg)", "var(--tx2)"], scout: ["var(--bluebg)", "var(--blue)"], implementer: ["var(--violetbg)", "var(--violet)"], reviewer: ["var(--greenbg)", "var(--green)"], thinker: ["var(--amberbg)", "var(--amber)"] };
const chip = (c) => CHIP[c] || ["var(--seg)", "var(--tx2)"];
const PAID = { OpenRouter: 1, DeepSeek: 1 };
const segStyle = (on) => ({ border: "0", height: "26px", padding: "0 10px", borderRadius: "7px", fontSize: "12px", whiteSpace: "nowrap", cursor: "pointer", background: on ? "var(--segon)" : "transparent", color: on ? "var(--tx)" : "var(--tx2)", fontWeight: on ? 600 : 400, boxShadow: on ? "0 1px 2px rgba(0,0,0,.08)" : "none" });
const STATE = { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", padding: "26px 12px", textAlign: "center", borderTop: "1px solid var(--line)" };
const BTN = { border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", borderRadius: "7px", height: "28px", padding: "0 12px", fontSize: "12px", cursor: "pointer" };

export default function RoutingMap({ data, state, onRetry, onShow30, rangeTitle }) {
  const [rMetric, setRMetric] = useState("req");
  const [hover, setHover] = useState(null);
  const [secRef, w] = useWidth();
  const [skRef, sw] = useWidth(900);
  const skEl = useRef(null);
  const narrow = w < 640;

  const routes = useMemo(() => mapRoutes(data?.groups?.routes), [data]);
  const rv = (l) => (rMetric === "req" ? l.req : rMetric === "value" ? l.value : l.real);
  const coTop = topPaidRoute(routes.l1);
  const loggedFrom = data?.loggedSince, rangeFrom = data?.range?.from, rangeTo = data?.range?.to;
  const hasRoutes = routes.l1.length > 0;
  const notRecorded = !hasRoutes && loggedFrom && rangeTo && rangeTo < loggedFrom;
  const since = hasRoutes && loggedFrom && rangeFrom && rangeFrom < loggedFrom ? `Showing ${data.loggedSinceLabel} – ${data.range.last}: combos are logged since ${data.loggedSinceLabel}.` : "";
  const live = state === "ready";
  const empty = state === "empty" || (live && !hasRoutes && !notRecorded);

  const onHover = (a, e) => {
    const el = skEl.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    if (x > r.width - 240) x = e.clientX - r.left - 244;
    if (y > r.height - 110) y = e.clientY - r.top - 110;
    setHover({ ...a, x, y });
  };

  const layout = live && hasRoutes && !narrow ? sankeyLayout(routes, rv, Math.max(560, sw), { paid: (p) => !!PAID[p] }) : null;
  const fm = (v) => (rMetric === "req" ? fN(v) : rMetric === "value" ? fV(v) : fR(v));

  const groups = live && hasRoutes && narrow ? [...new Set(routes.l1.map((l) => l.combo))].map((c) => {
    const ls = routes.l1.filter((l) => l.combo === c).sort((a, b) => rv(b) - rv(a));
    const [bg, fg] = chip(c);
    return {
      name: c, bg, c: fg, total: (c === "main" ? "No combo · " : "") + fLoc(sum(ls, (l) => l.req)) + " req · " + fV(sum(ls, (l) => l.value)) + " value",
      req: sum(ls, (l) => l.req),
      rows: ls.map((l) => ({ prov: l.prov, metric: fLoc(l.req) + " req", sub: l.paid ? fR(l.real) + " real" : fV(l.value) + " value", subColor: l.paid ? "var(--acc)" : "var(--violet)", edge: l.paid ? "var(--acc)" : "var(--line2)" })),
    };
  }).sort((a, b) => (a.name === "main" ? -1 : b.name === "main" ? 1 : b.req - a.req)) : [];

  const lab = (key, x, y, t1, t2, mono, strong) => (
    <text key={key} x={x} y={y} textAnchor="start" style={{ fontSize: mono ? 11 : 12, fontFamily: mono ? "var(--mono)" : "inherit", fill: strong ? "var(--tx)" : "var(--tx2)", fontWeight: strong ? 600 : 400, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round", pointerEvents: "none" }}>
      {t1}{t2 ? <tspan style={{ fill: "var(--tx3)", fontWeight: 400, fontFamily: "inherit", fontSize: 10.5 }}>{"  " + t2}</tspan> : null}
    </text>
  );

  return (
    <section ref={secRef} data-screen-label="Routing map" style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px", minWidth: "0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: "8px 16px" }}>
        <div style={{ minWidth: "0" }}>
          <span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)", textTransform: "uppercase" }}>Routing map</span>
          <div style={{ fontSize: "11.5px", color: "var(--tx3)", marginTop: "2px", textWrap: "pretty" }}>Where each combo lands: combo → provider → model. {since}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "0", maxWidth: "100%" }}>
          <span style={{ fontSize: "12px", color: "var(--tx3)", flex: "none" }}>Width by</span>
          <div className="r9-segment" style={{ overflowX: "auto", minWidth: "0" }}><div style={{ display: "flex", gap: "2px", padding: "3px", borderRadius: "9px", background: "var(--seg)", width: "max-content" }}>
            {[["req", "Requests"], ["value", "List-price value (est.)"], ["real", "Real spend"]].map(([k, l]) => <button key={k} onClick={() => { setRMetric(k); setHover(null); }} style={segStyle(rMetric === k)}>{l}</button>)}
          </div></div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: "11px", color: "var(--tx3)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "16px", height: "4px", borderRadius: "2px", background: "var(--line2)" }}></span>Subscription or local</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "16px", height: "4px", borderRadius: "2px", background: "var(--acc)" }}></span>Reaches a pay-per-token provider (real spend)</span>
      </div>

      {live && !empty && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {notRecorded && (
            <div style={{ position: "relative", height: "160px", borderRadius: "8px", border: "1px dashed var(--tx3)", background: "repeating-linear-gradient(135deg,var(--line2) 0 1px,transparent 1px 7px)", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "16px" }}>
              <div style={{ background: "var(--card)", borderRadius: "7px", padding: "8px 12px" }}><div style={{ fontWeight: "600" }}>Not recorded</div><div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>Combo routing is logged since {data.loggedSinceLabel}. This range ends before that.</div></div>
            </div>
          )}
          {hasRoutes && !narrow && (
            <div ref={(el) => { skEl.current = el; skRef(el); }} onMouseLeave={() => setHover(null)} style={{ position: "relative", width: "100%", minHeight: "396px" }}>
              {layout ? (
                <svg width={layout.W} height={layout.H} style={{ display: "block", overflow: "visible" }}>
                  {layout.bands.map((a) => {
                    const y0 = a.sy + a.w / 2, y1 = a.ty + a.w / 2, xm = (a.xa + a.xb) / 2, on = hover?.id === a.id;
                    return <path key={a.id} d={`M${a.xa},${y0} C${xm},${y0} ${xm},${y1} ${a.xb},${y1}`} onMouseEnter={(e) => onHover(a, e)} onMouseMove={(e) => onHover(a, e)}
                      style={{ fill: "none", stroke: a.paid ? "var(--acc)" : "var(--tx3)", strokeOpacity: a.paid ? (on ? 0.85 : 0.5) : on ? 0.5 : 0.2, strokeWidth: Math.max(1, a.w), cursor: "pointer", transition: "stroke-opacity .12s" }} />;
                  })}
                  {layout.combos.map((c) => (
                    <g key={"c" + c.key}>
                      <rect x={layout.x0} y={c.y} width={layout.nw} height={Math.max(2, c.h)} rx={2} style={{ fill: chip(c.key)[1] }} />
                      <text x={layout.x0 - 8} y={c.y + c.h / 2 - 1} textAnchor="end" style={{ fontSize: 12, fontFamily: "var(--mono)", fill: "var(--tx)", pointerEvents: "none" }}>{c.key}</text>
                      <text x={layout.x0 - 8} y={c.y + c.h / 2 + 12} textAnchor="end" style={{ fontSize: 10.5, fill: "var(--tx3)", pointerEvents: "none" }}>{(c.key === "main" ? "no combo · " : "") + fm(c.v)}</text>
                    </g>
                  ))}
                  {layout.provs.map((p) => (
                    <g key={"p" + p.key}>
                      <rect x={layout.x1} y={p.y} width={layout.nw} height={Math.max(2, p.h)} rx={2} style={{ fill: PAID[p.key] ? "var(--acc)" : "var(--tx2)" }} />
                      {lab("pt", layout.x1 + layout.nw + 6, p.y + p.h / 2 + 4, p.key, fm(p.v), false, true)}
                    </g>
                  ))}
                  {layout.models.map((m) => (
                    <g key={"m" + m.key}>
                      <rect x={layout.x2} y={m.y} width={layout.nw} height={Math.max(2, m.h)} rx={2} style={{ fill: PAID[m.prov] ? "var(--acc)" : "var(--tx3)" }} />
                      {lab("mt", layout.x2 + layout.nw + 6, m.ly, m.name, fm(m.v), true, false)}
                    </g>
                  ))}
                </svg>
              ) : <div style={{ padding: "40px 0", textAlign: "center", color: "var(--tx3)", fontSize: 12 }}>No combo traffic in this metric.</div>}
              {hover && (
                <div style={{ position: "absolute", left: hover.x + "px", top: hover.y + "px", width: "230px", pointerEvents: "none", background: "var(--card)", border: "1px solid var(--line2)", borderRadius: "8px", padding: "8px 10px", boxShadow: "0 4px 14px rgba(0,0,0,.12)", fontSize: "11.5px", display: "flex", flexDirection: "column", gap: "3px", fontVariantNumeric: "tabular-nums", zIndex: "4" }}>
                  <div style={{ fontWeight: "600", fontFamily: "var(--mono)", fontSize: "11.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hover.title}</div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--tx3)" }}>Requests</span><span>{fLoc(hover.req)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--tx3)" }}>List-price value (est.)</span><span style={{ color: "var(--violet)" }}>{fV(hover.value)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--tx3)" }}>Real spend</span><span style={{ color: hover.paid ? "var(--acc)" : "var(--tx3)" }}>{hover.paid ? fR(hover.real) : "— (subscription)"}</span></div>
                  {hover.est >= 0.005 && <div style={{ fontSize: "10.5px", color: "var(--tx3)", textAlign: "right" }}>{fR(hover.est)} of it estimated</div>}
                </div>
              )}
            </div>
          )}
          {hasRoutes && narrow && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {groups.map((g) => (
                <div key={g.name} style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--line)", paddingTop: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "4px" }}><span style={{ fontFamily: "var(--mono)", fontSize: "11.5px", padding: "1px 7px", borderRadius: "5px", background: g.bg, color: g.c }}>{g.name}</span><span style={{ fontSize: "11.5px", color: "var(--tx3)", fontVariantNumeric: "tabular-nums" }}>{g.total}</span></div>
                  {g.rows.map((x) => (
                    <div key={x.prov} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", padding: "5px 0 5px 10px", borderLeft: `2px solid ${x.edge}`, fontVariantNumeric: "tabular-nums" }}>
                      <div style={{ minWidth: "0" }}><div style={{ fontSize: "12.5px", fontWeight: "600" }}>{x.prov}</div></div>
                      <div style={{ textAlign: "right", flex: "none" }}><div style={{ fontSize: "12.5px" }}>{x.metric}</div><div style={{ fontSize: "11px", color: x.subColor }}>{x.sub}</div></div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {hasRoutes && coTop && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", background: "var(--acc2)", borderRadius: "8px", padding: "8px 12px", fontSize: "12.5px" }}><span style={{ ...MS, fontSize: "17px", color: "var(--acc)" }}>call_split</span><span><span style={{ fontFamily: "var(--mono)", fontWeight: "600" }}>{coTop.combo}</span> sent {fLoc(coTop.req)} requests (<span style={{ color: "var(--acc)", fontWeight: "600" }}>{fR(coTop.real)} real</span>) to {coTop.prov} in this range.</span></div>
          )}
          {hasRoutes && !coTop && <div style={{ fontSize: "12px", color: "var(--tx3)" }}>No combo traffic reached a pay-per-token provider in this range.</div>}
        </div>
      )}
      {state === "loading" && (
        <div style={{ display: "flex", gap: "10%", alignItems: "center", height: "240px", padding: "0 4%" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "10px" }}><div style={{ height: "50px", borderRadius: "3px", background: "var(--seg)" }}></div><div style={{ height: "70px", borderRadius: "3px", background: "var(--seg)" }}></div><div style={{ height: "40px", borderRadius: "3px", background: "var(--seg)" }}></div></div>
          <div style={{ flex: "1", height: "150px", borderRadius: "8px", background: "var(--seg)", opacity: ".6" }}></div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "10px" }}><div style={{ height: "60px", borderRadius: "3px", background: "var(--seg)" }}></div><div style={{ height: "90px", borderRadius: "3px", background: "var(--seg)" }}></div></div>
          <div style={{ flex: "1", height: "180px", borderRadius: "8px", background: "var(--seg)", opacity: ".6" }}></div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "10px" }}><div style={{ height: "30px", borderRadius: "3px", background: "var(--seg)" }}></div><div style={{ height: "30px", borderRadius: "3px", background: "var(--seg)" }}></div><div style={{ height: "50px", borderRadius: "3px", background: "var(--seg)" }}></div><div style={{ height: "30px", borderRadius: "3px", background: "var(--seg)" }}></div></div>
        </div>
      )}
      {empty && (
        <div style={STATE}>
          <span style={{ ...MS, fontSize: "24px", color: "var(--tx3)" }}>event_busy</span>
          <div style={{ fontWeight: "600" }}>No calls in this range</div>
          <div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>No combo routed a request during {rangeTitle}.</div>
          <button onClick={onShow30} style={BTN}>Show last 30 days</button>
        </div>
      )}
      {state === "error" && (
        <div style={STATE}>
          <span style={{ ...MS, fontSize: "24px", color: "var(--red)" }}>error</span>
          <div style={{ fontWeight: "600" }}>Couldn&apos;t load routing map</div>
          <div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>The routes query did not finish.</div>
          <button onClick={onRetry} style={BTN}>Retry</button>
        </div>
      )}
    </section>
  );
}
