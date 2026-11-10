"use client";

// Quota runway, ported from Spend.dc.html (round 2). Live data from /api/spend/quota; not affected by range.
import { useCallback, useEffect, useMemo, useState } from "react";
import { dur, fDT, fTime, mapQuotaRows, quotaTotal, sameDayIST, sortQuotaRunway } from "@/lib/spend/uiHelpers";
import useWidth from "./useWidth";
import { cacheGet, cacheSet, isFresh } from "@/lib/clientCache";

const QUOTA_URL = "/api/spend/quota", QUOTA_TTL = 15 * 60_000;
const fromCache = () => { const h = cacheGet(QUOTA_URL); if (!h) return null; const rows = h.data; return { state: rows.length ? "live" : "empty", rows, at: h.at, stale: false }; };

const MS = { fontFamily: "'Material Symbols Outlined'", lineHeight: 1 };
const RC = { high: "var(--red)", warn: "var(--amber)", ok: "var(--green)", unknown: "var(--tx3)", error: "var(--red)" };
const STATE = { padding: "26px 12px", textAlign: "center", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" };
const BTN = { border: "1px solid var(--line2)", background: "var(--card)", color: "var(--tx)", borderRadius: "7px", height: "28px", padding: "0 12px", fontSize: "12px", cursor: "pointer" };

export default function QuotaRunway({ syncNonce = 0 }) {
  const [res, setRes] = useState({ state: "loading", rows: [], at: null });
  const [all, setAll] = useState(false), [agOpen, setAgOpen] = useState(false), [now, setNow] = useState(() => Date.now());
  const [ref, w] = useWidth();
  const narrow = w < 640;

  const load = useCallback(async ({ quiet = false, useCache = false } = {}) => {
    // Quota is the slowest call (provider APIs). Reuse a recent result across page visits.
    if (useCache) {
      const c = fromCache(); // read after mount, so server and client render the same first frame
      if (c) setRes(c);
      if (isFresh(cacheGet(QUOTA_URL), QUOTA_TTL)) return;
    }
    if (!quiet) setRes((r) => (r.state === "live" ? r : { ...r, state: "loading" }));
    try {
      const r = await fetch("/api/spend/quota", { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      cacheSet(QUOTA_URL, rows);
      setRes({ state: rows.length ? "live" : "empty", rows, at: Date.now(), stale: false });
    } catch { setRes((r) => (quiet && r.state === "live" ? { ...r, stale: true } : { state: "error", rows: [], at: null })); }
  }, []);
  useEffect(() => { const t = setTimeout(() => load({ quiet: !!cacheGet(QUOTA_URL), useCache: true }), 0); return () => clearTimeout(t); }, [load]);
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(iv); }, []);
  // No polling: the page Sync button bumps syncNonce for a fresh read.
  useEffect(() => {
    if (!syncNonce) return;
    const t = setTimeout(() => load({ quiet: true }), 0);
    return () => clearTimeout(t);
  }, [syncNonce, load]);

  const sorted = useMemo(() => sortQuotaRunway(mapQuotaRows(res.rows)), [res.rows]);
  const total = quotaTotal(sorted);
  const shown = all ? sorted : sorted.slice(0, 6);

  const qRow = (r, child) => {
    if (r.risk === "error") return { id: r.id, prov: r.prov, win: r.win, isErr: true, err: r.err, indent: "0px", bg: "transparent" };
    const c = RC[r.risk];
    const proj = r.known && r.proj != null ? r.proj : null, projR = proj == null ? null : Math.round(proj);
    const pr = proj != null ? Math.min(proj, 100) : 0;
    const pct = r.pct || 0;
    let fText, fSub, fColor = c;
    if (r.usageOnly) { fText = "No limit reported"; fSub = "Usage only, no remaining amount"; fColor = "var(--tx3)"; }
    else if (!r.known || proj == null) { fText = "No forecast"; fSub = r.known ? "Too early in the window" : "Window length unknown"; fColor = "var(--tx3)"; }
    else if (r.runOut && r.runOut < r.reset) { fText = "Runs out in " + dur(r.runOut - now, 2); fSub = (sameDayIST(r.runOut, now) ? fTime(r.runOut) : fDT(r.runOut)) + " IST · " + dur(r.reset - r.runOut, 2) + " before reset"; }
    else { fText = "Safe until reset"; fSub = "~" + projR + "% at reset"; }
    return {
      id: r.id, prov: child ? "" : r.prov, win: r.win, usageOnly: !!r.usageOnly, usage: r.usage,
      usedW: pct + "%", projW: proj != null && pr > pct ? pr - pct + "%" : "0%", markL: "calc(" + pr + "% - 1px)", markD: proj != null ? "block" : "none", color: c,
      usedLabel: r.used || (r.pct == null ? "—" : Math.round(r.pct) + "%"), projLabel: proj != null ? " → " + projR + "%" : "", fText, fSub, fColor,
      cd: r.usageOnly || !r.reset ? "—" : "in " + dur(r.reset - now), resetAbs: r.usageOnly || !r.reset ? "Not reported" : (sameDayIST(r.reset, now) ? "today " + fTime(r.reset) : fDT(r.reset)) + " IST",
      hasMore: !!(r.more?.length || r.unused?.length) && !all, moreLabel: agOpen ? "Hide models" : r.more?.length ? "+" + (r.more.length + (r.unused?.length || 0)) + " models" : "+" + (r.unused?.length || 0) + " unused models", moreIcon: agOpen ? "expand_less" : "expand_more",
      indent: child ? "18px" : "0px", bg: child ? "var(--bg)" : "transparent",
    };
  };
  const rows = [];
  shown.forEach((r) => { rows.push(qRow(r)); if (agOpen || all) { (r.more || []).forEach((m) => rows.push(qRow(m, true))); (r.unused || []).forEach((m) => rows.push(qRow(m, true))); } });

  return (
    <section ref={ref} data-screen-label="Quota runway" style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "12px", boxShadow: "var(--shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "8px", minWidth: "0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "6px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "11.5px", fontWeight: "600", letterSpacing: ".05em", color: "var(--tx2)", textTransform: "uppercase" }}>Quota runway</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--tx3)" }}>
            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: res.state === "error" ? "var(--red)" : res.stale ? "var(--amber)" : "var(--green)" }}></span>
            {res.stale ? "Refresh failed, showing data from " + fTime(res.at) + " IST" : "Live, not affected by range" + (res.at ? " · updated " + fTime(res.at) + " IST" : "")}
            {res.stale && <button onClick={() => load()} style={{ border: "0", background: "transparent", color: "var(--acc)", fontSize: "11px", cursor: "pointer", padding: "0" }}>Retry</button>}
          </span>
        </div>
        <a href="/dashboard/quota" style={{ fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "2px" }}>Details in Quota Tracker<span style={{ ...MS, fontSize: "15px" }}>arrow_forward</span></a>
      </div>
      <div style={{ fontSize: "11.5px", color: "var(--tx3)", textWrap: "pretty" }}>Which subscription runs out first at today&apos;s rate. Forecasts appear only where the provider reports the window length.</div>

      {res.state === "live" && (
        <div>
          {!narrow && (
            <div style={{ display: "flex", gap: "14px", padding: "6px 0", fontSize: "11px", fontWeight: "600", color: "var(--tx3)", letterSpacing: ".04em", textTransform: "uppercase" }}>
              <div style={{ flex: "1 1 180px", minWidth: "0" }}>Subscription · window</div>
              <div style={{ flex: "2 1 240px", minWidth: "0" }}>Used now → at reset</div>
              <div style={{ flex: "1 1 160px", minWidth: "0" }}>Forecast</div>
              <div style={{ flex: "0 0 140px", textAlign: "right" }}>Resets in</div>
            </div>
          )}
          {rows.map((r) => (
            <div key={r.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", padding: `9px 0 9px ${r.indent}`, borderTop: "1px solid var(--line)", background: r.bg }}>
              <div style={{ flex: "1 1 180px", minWidth: "0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: "600", color: "var(--tx)" }}>{r.prov}</span>
                  {r.hasMore && <button onClick={() => setAgOpen((o) => !o)} style={{ border: "0", background: "var(--seg)", color: "var(--tx2)", fontSize: "11px", padding: "1px 7px", borderRadius: "5px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "2px" }}>{r.moreLabel}<span style={{ ...MS, fontSize: "14px" }}>{r.moreIcon}</span></button>}
                </div>
                <div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>{r.win}</div>
              </div>
              {r.isErr ? (
                <div style={{ flex: "4 1 420px", minWidth: "0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", background: "var(--redbg)", color: "var(--red)", borderRadius: "7px", padding: "6px 10px", fontSize: "12px" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ ...MS, fontSize: "16px" }}>error</span>{r.err}</span>
                  <button onClick={() => load()} style={{ border: "0", background: "transparent", color: "var(--red)", fontWeight: "600", fontSize: "12px", cursor: "pointer", padding: "0" }}>Retry</button>
                </div>
              ) : (
                <>
                  <div style={{ flex: "2 1 240px", minWidth: "0" }}>
                    {r.usageOnly ? <div style={{ fontSize: "12px", color: "var(--tx3)", fontVariantNumeric: "tabular-nums" }}>{r.usage}</div> : (
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <div style={{ position: "relative", flex: "1", height: "6px", borderRadius: "3px", background: "var(--seg)" }}>
                          <div style={{ position: "absolute", left: "0", top: "0", bottom: "0", width: r.usedW, background: r.color, borderRadius: "3px" }}></div>
                          <div style={{ position: "absolute", top: "0", bottom: "0", left: r.usedW, width: r.projW, background: `repeating-linear-gradient(135deg,${r.color} 0 2px,transparent 2px 4px)`, opacity: ".6" }}></div>
                          <div style={{ position: "absolute", top: "-4px", height: "14px", width: "2px", borderRadius: "1px", left: r.markL, background: "var(--tx)", display: r.markD }}></div>
                        </div>
                        <div style={{ fontSize: "12px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", minWidth: "92px", textAlign: "right" }}><b>{r.usedLabel}</b><span style={{ color: "var(--tx3)" }}>{r.projLabel}</span></div>
                      </div>
                    )}
                  </div>
                  <div style={{ flex: "1 1 160px", minWidth: "0" }}>
                    <div style={{ fontSize: "12.5px", fontWeight: "600", color: r.fColor }}>{r.fText}</div>
                    <div style={{ fontSize: "11px", color: "var(--tx3)" }}>{r.fSub}</div>
                  </div>
                  <div style={{ flex: "0 0 140px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    <div style={{ fontSize: "12.5px" }}>{r.cd}</div>
                    <div style={{ fontSize: "11px", color: "var(--tx3)" }}>{r.resetAbs}</div>
                  </div>
                </>
              )}
            </div>
          ))}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "8px 16px", borderTop: "1px solid var(--line)", paddingTop: "10px" }}>
            {total > 6 ? <button onClick={() => setAll((a) => !a)} style={{ border: "0", background: "transparent", color: "var(--acc)", fontSize: "12px", cursor: "pointer", padding: "0", display: "inline-flex", alignItems: "center", gap: "2px" }}>{all ? "Show top 6" : "Show all " + total}<span style={{ ...MS, fontSize: "16px" }}>{all ? "expand_less" : "expand_more"}</span></button> : <span></span>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", fontSize: "11px", color: "var(--tx3)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "14px", height: "6px", borderRadius: "3px", background: "var(--tx3)" }}></span>Used</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "14px", height: "6px", borderRadius: "3px", background: "repeating-linear-gradient(135deg,var(--tx3) 0 2px,transparent 2px 4px)" }}></span>Projected by reset</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "2px", height: "11px", borderRadius: "1px", background: "var(--tx)" }}></span>At reset</span>
              <span>Green &lt;70% · amber 70–90% or forecast &gt;85% · red &gt;90% or forecast &gt;100% · grey unknown</span>
            </div>
          </div>
        </div>
      )}
      {res.state === "loading" && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: "14px", alignItems: "center", padding: "12px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ flex: "1 1 180px", height: "12px", borderRadius: "4px", background: "var(--seg)" }} className="r9-shimmer"></div>
              <div style={{ flex: "2 1 240px", height: "6px", borderRadius: "3px", background: "var(--seg)" }} className="r9-shimmer"></div>
              <div style={{ flex: "1 1 160px", height: "12px", borderRadius: "4px", background: "var(--seg)" }} className="r9-shimmer"></div>
            </div>
          ))}
        </div>
      )}
      {res.state === "empty" && (
        <div style={STATE}>
          <span style={{ ...MS, fontSize: "24px", color: "var(--tx3)" }}>hourglass_empty</span>
          <div style={{ fontWeight: "600" }}>No quota windows reported</div>
          <div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>None of your subscriptions returned usage windows.</div>
          <a href="/dashboard/quota" style={{ fontSize: "12px" }}>Open Quota Tracker</a>
        </div>
      )}
      {res.state === "error" && (
        <div style={STATE}>
          <span style={{ ...MS, fontSize: "24px", color: "var(--red)" }}>error</span>
          <div style={{ fontWeight: "600" }}>Couldn&apos;t load quota windows</div>
          <div style={{ fontSize: "11.5px", color: "var(--tx3)" }}>The quota service did not answer.</div>
          <button onClick={() => load()} style={BTN}>Retry</button>
        </div>
      )}
    </section>
  );
}

