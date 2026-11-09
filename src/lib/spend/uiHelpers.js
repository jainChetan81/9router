// Pure helpers for the Spend v2 sections (quota runway, breakdown drill-down, routing map).
// Ported from the Claude Design file "Spend.dc.html" (round 2) renderVals and buildSankey.

const IST = 19800000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const P2 = (n) => String(n).padStart(2, "0");
const dI = (t) => new Date(t + IST);
const loc = (v, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export const fDate = (t) => { const d = dI(t); return MON[d.getUTCMonth()] + " " + d.getUTCDate(); };
export const fTime = (t) => { const d = dI(t); return P2(d.getUTCHours()) + ":" + P2(d.getUTCMinutes()); };
export const fDT = (t) => fDate(t) + ", " + fTime(t);
export const sameDayIST = (a, b) => dI(a).toISOString().slice(0, 10) === dI(b).toISOString().slice(0, 10);
export const dur = (ms, u = 3) => {
  if (ms <= 0) return "now";
  let m = Math.round(ms / 6e4); const d = Math.floor(m / 1440); m -= d * 1440; const h = Math.floor(m / 60); m -= h * 60;
  const p = []; if (d) p.push(d + " d"); if (h || d) p.push(h + " h"); p.push(m + " m");
  return p.slice(0, u).join(" ");
};
export const fR = (v) => (v == null ? "—" : v === 0 ? "$0.00" : v < 0.005 ? "<$0.01" : "$" + loc(v, 2));
export const fV = (v) => (v == null ? "—" : v === 0 ? "$0.00" : v < 0.005 ? "<$0.01" : v < 100 ? "$" + loc(v, 2) : "$" + loc(v, 0));
export const fN = (v) => { v = Math.round(v); return v < 1000 ? String(v) : v < 1e6 ? (v / 1e3).toFixed(1) + "k" : (v / 1e6).toFixed(1) + "M"; };
export const fT = (v) => (v < 1000 ? String(Math.round(v)) : v < 1e6 ? (v / 1e3).toFixed(1) + "k" : v < 1e9 ? (v / 1e6).toFixed(1) + "M" : (v / 1e9).toFixed(2) + "B");
export const fP = (p) => (p <= 0 ? "0.0%" : p < 0.1 ? "<0.1%" : p.toFixed(1) + "%");
export const fVpr = (v) => (v < 0.0005 ? "<$0.001" : v < 0.1 ? "$" + v.toFixed(3) : "$" + v.toFixed(2));
export const fLoc = (v) => loc(v);
export const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

// ---------- Quota runway ----------
export const PROVIDER_NAMES = {
  claude: "Claude Code", codex: "OpenAI Codex", antigravity: "Antigravity", "opencode-go": "OpenCode Go", muse: "Muse",
  openrouter: "OpenRouter", deepseek: "DeepSeek", "ollama-local": "Ollama", ollama: "Ollama", opencode: "OpenCode Free",
};
export const RISK_RANK = { high: 0, warn: 1, ok: 2, unknown: 3, error: 4 };

// "gemini_weekly (Gemini (Weekly))" -> "Gemini (Weekly)"; plain names stay as they are.
export function windowLabel(window) {
  const s = String(window || "");
  const i = s.indexOf(" (");
  // Only "key (Display name)" rows, where the key is an identifier such as gemini_weekly.
  return i > 0 && s.endsWith(")") && /^[\w.]*[_-][\w.-]*$/.test(s.slice(0, i)) ? s.slice(i + 2, -1) : s;
}

const MUSE_WIN = /^Last (\w+) (requests|tokens)$/i;
const museSpan = (w) => w.replace(/(\d+)([a-z])/i, "$1 $2"); // "5h" -> "5 h"

// API quota rows -> runway rows: Muse request/token pairs merge into one usage row per span;
// Antigravity per-model rows with no known window collapse into one row per connection.
export function mapQuotaRows(apiRows = []) {
  const out = [], muse = new Map(), agModels = new Map();
  for (const r of apiRows) {
    const prov = PROVIDER_NAMES[r.provider] || r.provider;
    if (r.error) { out.push({ id: `${r.provider}:${r.name}:err`, prov, win: r.name || "", risk: "error", err: `${prov}: ${r.error}` }); continue; }
    const m = r.provider === "muse" && MUSE_WIN.exec(String(r.window || ""));
    if (m) {
      const key = `${r.name}|${m[1]}`;
      const o = muse.get(key) || { id: `muse:${key}`, prov, win: "Last " + museSpan(m[1]), usageOnly: true, risk: "unknown", order: muse.size };
      o[m[2].toLowerCase() === "requests" ? "req" : "tok"] = Number(r.used) || 0;
      muse.set(key, o); continue;
    }
    const known = r.windowMs != null && r.limitKnown !== false;
    const row = {
      id: `${r.provider}:${r.name}:${r.window}`, prov, win: windowLabel(r.window), pct: r.usedPct == null ? null : Number(r.usedPct),
      reset: r.resetAt, known, proj: r.projectedPct == null ? null : Math.round(r.projectedPct), runOut: r.runsOutAt,
      risk: r.limitKnown === false || r.usedPct == null ? "unknown" : r.risk || "unknown",
    };
    if (r.provider === "antigravity" && r.windowMs == null) {
      row.used = fLoc(Number(r.used) || 0) + " / 1,000"; row.known = false; row.risk = "unknown";
      const list = agModels.get(r.name) || []; list.push(row); agModels.set(r.name, list); continue;
    }
    out.push(row);
  }
  for (const [name, list] of agModels) {
    list.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
    out.push({ ...list[0], id: `antigravity:${name}:models`, more: list.slice(1) });
  }
  for (const o of muse.values()) out.push({ ...o, usage: `${fLoc(o.req || 0)} req · ${fT(o.tok || 0)} tok` });
  return out;
}

const usedRank = (r) => (r.usageOnly ? -1 : r.pct || 0);
export function sortQuotaRunway(rows = []) {
  return [...rows].sort((a, b) => (RISK_RANK[a.risk] ?? 4) - (RISK_RANK[b.risk] ?? 4) || usedRank(b) - usedRank(a));
}
// Total row count for "Show all N": parents plus every collapsed child.
export const quotaTotal = (rows) => rows.length + sum(rows, (r) => (r.more ? r.more.length : 0));

// ---------- Routing map ----------
// API routes (combo->provider and provider->model edges) -> design links {combo, prov, model, req, value, real, est, paid}.
// Each edge kind is kept separate; the Sankey draws combo->provider bands from the first kind and
// provider->model bands from the second, so each provider node's in-flow equals its out-flow.
export function mapRoutes(routes, provName = (k) => PROVIDER_NAMES[k] || k) {
  const l1 = [], l2 = [];
  for (const l of routes?.links || []) {
    const v = { req: Number(l.req) || 0, value: Number(l.v) || 0, real: Number(l.real) || 0, est: Number(l.realEst) || 0, paid: !!l.paid };
    if (String(l.source).startsWith("combo:")) l1.push({ ...v, combo: l.source.slice(6), prov: provName(String(l.target).replace(/^provider:/, "")) });
    else {
      const pk = String(l.source).replace(/^provider:/, "");
      const t = String(l.target);
      const model = t.startsWith(`model:${pk}:`) ? t.slice(`model:${pk}:`.length) : t.endsWith(":other-models") ? "other models" : t;
      l2.push({ ...v, prov: provName(pk), model });
    }
  }
  return { l1, l2 };
}

// Design buildSankey layout with the min-slot scaling, as pure data.
export function sankeyLayout({ l1, l2 }, val, W, opts = {}) {
  const nw = 8, top = 10;
  const A = l1.filter((l) => val(l) > 0), B = l2.filter((l) => val(l) > 0);
  if (!A.length && !B.length) return null;
  const cV = {}, pV = {}, mV = {};
  A.forEach((l) => { cV[l.combo] = (cV[l.combo] || 0) + val(l); });
  // A provider node's height is the larger of its in- and out-flow (equal when every row is logged).
  const pIn = {}, pOut = {};
  A.forEach((l) => { pIn[l.prov] = (pIn[l.prov] || 0) + val(l); });
  B.forEach((l) => { pOut[l.prov] = (pOut[l.prov] || 0) + val(l); const k = l.prov + "|" + l.model; mV[k] = (mV[k] || 0) + val(l); });
  const combos = Object.keys(cV).sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : cV[b] - cV[a]));
  const provs = [...new Set([...Object.keys(pIn), ...Object.keys(pOut)])];
  provs.forEach((p) => { pV[p] = Math.max(pIn[p] || 0, pOut[p] || 0); });
  provs.sort((a, b) => (opts.paid?.(a) ? 1 : 0) - (opts.paid?.(b) ? 1 : 0) || pV[b] - pV[a]);
  const models = [];
  provs.forEach((p) => Object.keys(mV).filter((k) => k.startsWith(p + "|")).sort((a, b) => mV[b] - mV[a]).forEach((k) => models.push(k)));
  const total = Math.max(sum(Object.values(cV), (x) => x), sum(Object.values(pV), (x) => x), 1e-9);
  const COLS = [[combos, cV, 30, 10], [provs, pV, 18, 10], [models, mV, 16, 6]];
  const need = (kk) => Math.max(...COLS.map(([ids, V, mn, g]) => sum(ids, (i) => Math.max(V[i] * kk, mn)) + g * Math.max(0, ids.length - 1)));
  const H = Math.max(380, need(0) + 90);
  let lo = 0, hi = H / total;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (need(mid) <= H) lo = mid; else hi = mid; }
  const k = lo;
  const place = ([ids, V, mn, g]) => {
    const t = sum(ids, (i) => Math.max(V[i] * k, mn)) + g * Math.max(0, ids.length - 1);
    let y = top + (H - t) / 2; const o = {};
    ids.forEach((i) => { const bh = V[i] * k, sh = Math.max(bh, mn); o[i] = { y: y + (sh - bh) / 2, h: bh }; y += sh + g; });
    return o;
  };
  const cP = place(COLS[0]), pP = place(COLS[1]), mP = place(COLS[2]);
  const x0 = 110, x1 = Math.round(W * 0.42), x2 = W - 220;
  const agg = (list, keyF, mk) => {
    const o = {};
    list.forEach((l) => { const id = keyF(l); const a = o[id] || (o[id] = Object.assign({ req: 0, value: 0, real: 0, est: 0, paid: l.paid }, mk(l))); a.req += l.req; a.value += l.value; a.real += l.real; a.est += l.est; });
    return Object.values(o);
  };
  const b1 = agg(A, (l) => l.combo + ">" + l.prov, (l) => ({ combo: l.combo, prov: l.prov, id: "1" + l.combo + ">" + l.prov, title: l.combo + " → " + l.prov }));
  const b2 = agg(B, (l) => l.prov + "|" + l.model, (l) => ({ prov: l.prov, mk: l.prov + "|" + l.model, id: "2" + l.prov + "|" + l.model, title: l.prov + " → " + l.model }));
  b1.forEach((a) => { a.m = val(a); }); b2.forEach((a) => { a.m = val(a); });
  combos.forEach((c) => { let y = cP[c].y; b1.filter((a) => a.combo === c).sort((a, b) => provs.indexOf(a.prov) - provs.indexOf(b.prov)).forEach((a) => { a.sy = y; y += a.m * k; }); });
  provs.forEach((p) => { let y = pP[p].y; b1.filter((a) => a.prov === p).sort((a, b) => combos.indexOf(a.combo) - combos.indexOf(b.combo)).forEach((a) => { a.ty = y; y += a.m * k; }); });
  provs.forEach((p) => { let y = pP[p].y; b2.filter((a) => a.prov === p).sort((a, b) => models.indexOf(a.mk) - models.indexOf(b.mk)).forEach((a) => { a.sy = y; y += a.m * k; }); });
  b2.forEach((a) => { a.ty = mP[a.mk].y; });
  const bands = [
    ...b1.map((a) => ({ ...a, w: a.m * k, xa: x0 + nw, xb: x1 })),
    ...b2.map((a) => ({ ...a, w: a.m * k, xa: x1 + nw, xb: x2 })),
  ];
  // Model labels never overlap: each sits at least 13 px below the previous one.
  let lastY = -99;
  const modelNodes = models.map((mkey) => {
    const p = mP[mkey]; const pn = mkey.split("|")[0];
    const ly = Math.max(p.y + p.h / 2 + 4, lastY + 13); lastY = ly;
    return { key: mkey, prov: pn, name: mkey.slice(pn.length + 1), y: p.y, h: p.h, ly, v: mV[mkey] };
  });
  return {
    W, H: H + top * 2, nw, x0, x1, x2, bands,
    combos: combos.map((c) => ({ key: c, y: cP[c].y, h: cP[c].h, v: cV[c] })),
    provs: provs.map((p) => ({ key: p, y: pP[p].y, h: pP[p].h, v: pV[p] })),
    models: modelNodes,
  };
}

// The combo whose traffic put the most real spend on one pay-per-token provider.
export function topPaidRoute(l1) {
  const agg = {};
  l1.filter((l) => l.paid).forEach((l) => { const k = l.combo + ">" + l.prov; const o = agg[k] || (agg[k] = { combo: l.combo, prov: l.prov, req: 0, real: 0 }); o.req += l.req; o.real += l.real; });
  return Object.values(agg).filter((o) => o.req > 0).sort((a, b) => b.real - a.real || b.req - a.req)[0] || null;
}
