import { clientOf } from "../spendClient.js";
import { addModelEffortUsage } from "./modelEffortGroups.js";
import { PAID } from "./drilldown.js";
import { DAY_MS, HOUR_MS, fmtIstDay, fmtIstHhmm, istDayKey, istMidnightMs } from "./time.js";

// Spend aggregates usageHistory into the numbers the Spend page shows.
// "value" = list-price cost of subscription calls (not billed); "real" = money paid
// to pay-per-token providers. Days and hours are bucketed in IST (UTC+5:30).
export const SUBS = [
  { k: "claude", provider: "claude", name: "Claude Code" },
  { k: "codex", provider: "codex", name: "OpenAI Codex" },
  { k: "antigravity", provider: "antigravity", name: "Antigravity" },
  { k: "ocgo", provider: "opencode-go", name: "OpenCode Go" },
  { k: "muse", provider: "muse", name: "Muse" },
];
export const SUB_OF = Object.fromEntries(SUBS.map((s) => [s.provider, s.k]));
export const PRESET_DAYS = { "7D": 7, "30D": 30, "60D": 60 };
export const DAYKEY = /^\d{4}-\d{2}-\d{2}$/;

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 20;
const adapterState = new WeakMap();
let feesVersion = 0;

function getState(db) {
  let st = adapterState.get(db);
  if (!st) {
    st = { meta: null, cache: new Map() };
    adapterState.set(db, st);
  }
  return st;
}

export function invalidateSpendCache(db) {
  feesVersion++;
  if (db) {
    const st = adapterState.get(db);
    if (st) st.cache.clear();
  }
}

export function resolveRange(params, now, firstMs) {
  const get = (k) => (typeof params?.get === "function" ? params.get(k) : params?.[k]);
  const preset = get("preset") || "30D";
  const today0 = istMidnightMs(now);
  if (preset === "Today") return { preset, hourly: true, from: today0, to: today0 + DAY_MS };
  if (preset === "24h") {
    const end = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
    return { preset, hourly: true, from: end - DAY_MS, to: end };
  }
  if (preset === "Custom") {
    const f = get("from"), t = get("to");
    if (DAYKEY.test(f || "") && DAYKEY.test(t || "") && !Number.isNaN(Date.parse(f)) && !Number.isNaN(Date.parse(t))) {
      const a = Date.parse(f + "T00:00:00Z") - (5.5 * HOUR_MS);
      const b = Date.parse(t + "T00:00:00Z") - (5.5 * HOUR_MS) + DAY_MS;
      if (b > a && a <= today0 && b - a <= 400 * DAY_MS) {
        return { preset, hourly: false, from: a, to: Math.min(b, today0 + DAY_MS) };
      }
    }
  }
  if (preset === "All") {
    return { preset, hourly: false, from: istMidnightMs(Math.min(firstMs || now, now)), to: today0 + DAY_MS };
  }
  const n = PRESET_DAYS[preset] || 30;
  return { preset: PRESET_DAYS[preset] ? preset : "30D", hourly: false, from: today0 - (n - 1) * DAY_MS, to: today0 + DAY_MS };
}

function bump(map, k, init) {
  let v = map.get(k);
  if (!v) { v = init(); map.set(k, v); }
  return v;
}
const acc = () => ({ v: 0, real: 0, realEst: 0, list: 0, req: 0, tok: 0 });
const tokNode = () => ({ v: 0, real: 0, realEst: 0, req: 0, tok: 0, tokSplit: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });

function feedNode(target, row, split) {
  target.v += row.costSum;
  target.real += row.realSum;
  target.realEst += row.realEstSum;
  target.req += row.req;
  target.tok += split.input + split.cacheRead + split.cacheWrite + split.output;
  target.tokSplit.input += split.input;
  target.tokSplit.cacheRead += split.cacheRead;
  target.tokSplit.cacheWrite += split.cacheWrite;
  target.tokSplit.output += split.output;
}

function safeClientOf(hasUa, ua) {
  if (!hasUa) return null;
  if (typeof ua === "string") return clientOf(ua);
  return clientOf(ua == null ? "" : String(ua));
}

function safeParseMeta(raw) {
  if (!raw || raw === "{}") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const META_VALID = "(meta IS NOT NULL AND meta != '{}' AND json_valid(meta) = 1)";
const TOK_VALID = "(tokens IS NOT NULL AND tokens != '{}' AND json_valid(tokens) = 1)";
const COST_EXPR = "(CASE WHEN typeof(cost) IN ('integer', 'real') THEN cost ELSE 0.0 END)";
const REAL_SET = `(${META_VALID} AND json_type(meta, '$.realCost') IN ('integer', 'real'))`;
const REAL_EXPR = `(CASE WHEN ${REAL_SET} THEN json_extract(meta, '$.realCost') WHEN provider IN ('openrouter', 'deepseek') THEN ${COST_EXPR} ELSE 0.0 END)`;
const REAL_EST_EXPR = `(CASE WHEN ${REAL_SET} THEN 0.0 WHEN provider IN ('openrouter', 'deepseek') THEN ${COST_EXPR} ELSE 0.0 END)`;

// Token expressions guarded by json_valid(tokens) so malformed JSON rows fall back safely without SQLite errors.
const PT_EXPR = `COALESCE(CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.prompt_tokens'), '') END, CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.input_tokens'), '') END, promptTokens, 0)`;
const CR_EXPR = `MAX(0, COALESCE(CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.cached_tokens'), '') END, CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.cache_read_input_tokens'), '') END, 0))`;
const CW_EXPR = `MAX(0, COALESCE(CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.cache_creation_input_tokens'), '') END, 0))`;
const OUT_EXPR = `MAX(0, COALESCE(CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.completion_tokens'), '') END, CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.output_tokens'), '') END, completionTokens, 0))`;

export function aggregateSpend(db, { params, now = Date.now(), fees = {}, skipCache = false } = {}) {
  const st = getState(db);
  const maxRow = db.get(`SELECT MAX(id) AS maxId FROM usageHistory`);
  const maxId = maxRow?.maxId ?? null;

  let firstMs, loggedSince;
  if (!skipCache && st.meta && st.meta.maxId === maxId && (now - st.meta.ts) < CACHE_TTL_MS) {
    firstMs = st.meta.firstMs;
    loggedSince = st.meta.loggedSince;
  } else {
    const first = db.get(`SELECT MIN(timestamp) AS t FROM usageHistory`);
    firstMs = first?.t ? Date.parse(first.t) : now;
    if (!skipCache && st.meta && st.meta.maxId === maxId && st.meta.loggedSince !== undefined) {
      loggedSince = st.meta.loggedSince;
    } else {
      const logged = db.get(`SELECT MIN(timestamp) AS t FROM usageHistory WHERE meta LIKE '%"ua"%'`);
      loggedSince = logged?.t ? Date.parse(logged.t) : null;
    }
    st.meta = { maxId, firstMs, loggedSince, ts: now };
  }

  const range = resolveRange(params, now, firstMs);
  const halfHourBucket = Math.floor(now / 18e5);
  const feeSig = SUBS.map((s) => `${s.k}=${fees?.[s.k] ?? ""}`).join("&");
  const cacheKey = `${range.preset}|${range.from}|${range.to}|${range.hourly ? 1 : 0}|${halfHourBucket}|${maxId}|${feesVersion}|${feeSig}`;

  if (!skipCache) {
    const hit = st.cache.get(cacheKey);
    if (hit && (now - hit.ts) < CACHE_TTL_MS && hit.maxId === maxId && hit.feesVersion === feesVersion) {
      // Refresh LRU insertion order
      st.cache.delete(cacheKey);
      st.cache.set(cacheKey, hit);
      return { ...hit.body, now };
    }
  }

  const step = range.hourly ? HOUR_MS : DAY_MS;
  const nB = Math.round((range.to - range.from) / step);
  const bars = Array.from({ length: nB }, (_, i) => {
    const t = range.from + i * step;
    return {
      t, val: 0, real: 0, list: 0, subs: {},
      future: t > now,
      logged: true, // real spend comes from the cost column, known for all history
      label: range.hourly ? `${fmtIstDay(t)}, ${fmtIstHhmm(t)}` : fmtIstDay(t),
      tick: range.hourly ? fmtIstHhmm(t).slice(0, 2) : fmtIstDay(t),
    };
  });

  const fromIso = new Date(range.from).toISOString();
  const toIso = new Date(range.to).toISOString();
  // On ranges >= 7 days (~70k-140k rows), sequential scan avoids slow idx_uh_ts random lookups.
  const wideScan = (range.to - range.from) >= 7 * DAY_MS;
  const tsWhere = wideScan ? "+timestamp >= ? AND +timestamp < ?" : "timestamp >= ? AND timestamp < ?";

  const keyNames = new Map(db.all(`SELECT key, name FROM apiKeys`).map((r) => [r.key, r.name]));

  // Unified single-pass SQL GROUP BY covering bars, breakdowns, model+effort, drilldown, routes, and sessions.
  const mainRows = db.all(
    `SELECT
       CASE
         WHEN unixepoch(timestamp, 'subsec') IS NULL THEN -1
         WHEN CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) < ? THEN -1
         ELSE CAST((CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) - ?) / ? AS INTEGER)
       END AS barIdx,
       provider,
       model,
       apiKey,
       CASE WHEN ${META_VALID} AND json_type(meta, '$.ua') IS NOT NULL THEN 1 ELSE 0 END AS hasUa,
       CASE WHEN ${META_VALID} THEN json_extract(meta, '$.ua') ELSE NULL END AS ua,
       CASE WHEN ${META_VALID} AND json_type(meta, '$.combo') = 'text' THEN NULLIF(json_extract(meta, '$.combo'), '') ELSE NULL END AS combo,
       CASE WHEN ${META_VALID} AND json_type(meta, '$.sentEffort') = 'text' THEN NULLIF(json_extract(meta, '$.sentEffort'), '') ELSE NULL END AS effort,
       COALESCE(NULLIF(session, ''), CASE WHEN ${META_VALID} AND json_type(meta, '$.session') = 'text' THEN NULLIF(json_extract(meta, '$.session'), '') END) AS sess,
       MIN(id) AS minId,
       MIN(CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER)) AS startMs,
       MAX(CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER)) AS endMs,
       COUNT(*) AS req,
       SUM(${COST_EXPR}) AS costSum,
       SUM(${REAL_EXPR}) AS realSum,
       SUM(${REAL_EST_EXPR}) AS realEstSum,
       SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)) AS tokSum,
       SUM(MAX(0, (${PT_EXPR}) - (${CR_EXPR}) - (${CW_EXPR}))) AS inSum,
       SUM(${CR_EXPR}) AS crSum,
       SUM(${CW_EXPR}) AS cwSum,
       SUM(${OUT_EXPR}) AS outSum
     FROM usageHistory
     WHERE ${tsWhere}
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
     ORDER BY minId ASC`,
    [range.from, range.from, step, fromIso, toIso],
  );

  const clock = db.all(`SELECT CAST(strftime('%w', timestamp, '+5 hours', '+30 minutes') AS INTEGER) AS weekday,
    CAST(strftime('%H', timestamp, '+5 hours', '+30 minutes') AS INTEGER) AS hour,
    COUNT(*) AS req, SUM(${COST_EXPR}) AS cost
    FROM usageHistory WHERE ${tsWhere} AND unixepoch(timestamp, 'subsec') IS NOT NULL
    GROUP BY 1, 2`, [fromIso, toIso]);
  const whatIfGroups = new Map();
  const byKey = new Map(), byModel = new Map(), byModelEffort = new Map();
  const byCombo = new Map(), byClient = new Map(), bySess = new Map(), byProv = new Map();
  const ddProviders = new Map(), ddModelSplits = new Map(), ddRoutes = new Map();
  const subs = Object.fromEntries(SUBS.map((s) => [s.k, 0]));
  let value = 0, real = 0, realEst = 0, list = 0, req = 0, tok = 0, realOr = 0, realDs = 0, nrList = 0, nrReq = 0, nrTok = 0;

  for (const r of mainRows) {
    const b = bars[r.barIdx];
    if (!b) continue;
    const costSum = Number(r.costSum) || 0;
    const realSum = Number(r.realSum) || 0;
    const realEstSum = Number(r.realEstSum) || 0;
    const rReq = Number(r.req) || 0;
    const tokSum = Number(r.tokSum) || 0;
    const split = {
      input: Number(r.inSum) || 0,
      cacheRead: Number(r.crSum) || 0,
      cacheWrite: Number(r.cwSum) || 0,
      output: Number(r.outSum) || 0,
    };

    for (const [kind, name] of [["model", r.model], ["combo", r.hasUa ? (r.combo || "main") : null]]) {
      if (!name) continue;
      const id = JSON.stringify([kind, name]);
      let group = whatIfGroups.get(id);
      if (!group) whatIfGroups.set(id, group = { kind, name, cost: 0, req: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      group.cost += costSum; group.req += rReq;
      for (const key of ["input", "cacheRead", "cacheWrite", "output"]) group[key] += split[key];
    }

    const provider = r.provider || "unknown";
    const model = r.model || "unknown";
    const effort = r.effort || "Unknown";

    // Model + effort (matches addModelEffortUsage totals)
    const meKey = JSON.stringify([model, effort]);
    let me = byModelEffort.get(meKey);
    if (!me) {
      me = { k: `${model} · ${effort}`, model, effort, v: 0, real: 0, realEst: 0, req: 0, tok: 0 };
      byModelEffort.set(meKey, me);
    }
    me.v += costSum; me.real += realSum; me.realEst += realEstSum; me.req += rReq; me.tok += tokSum;

    // Bars & top-level totals
    b.list += costSum;
    b.real += realSum;
    const keyName = keyNames.get(r.apiKey) || (r.apiKey ? "Unknown key" : "No key");
    (b.keys ||= new Map()).set(keyName, (b.keys.get(keyName) || 0) + costSum);
    const sk = SUB_OF[r.provider];
    if (sk) {
      b.val += costSum;
      b.subs[sk] = (b.subs[sk] || 0) + costSum;
      subs[sk] += costSum;
      value += costSum;
    }
    real += realSum; realEst += realEstSum; list += costSum; req += rReq; tok += tokSum;
    if (r.provider === "openrouter") realOr += realSum;
    else if (r.provider === "deepseek") realDs += realSum;

    const client = safeClientOf(r.hasUa, r.ua);
    const role = r.hasUa ? (r.combo || "main") : null;

    // Drilldown: providerTree, tokenSplit, routes
    const ddRow = { costSum, realSum, realEstSum, req: rReq };
    let dp = ddProviders.get(provider);
    if (!dp) ddProviders.set(provider, dp = { ...tokNode(), models: new Map() });
    feedNode(dp, ddRow, split);
    let dm = dp.models.get(model);
    if (!dm) dp.models.set(model, dm = { ...tokNode(), efforts: new Map() });
    feedNode(dm, ddRow, split);
    let de = dm.efforts.get(effort);
    if (!de) dm.efforts.set(effort, de = tokNode());
    feedNode(de, ddRow, split);

    let ms = ddModelSplits.get(model);
    if (!ms) ddModelSplits.set(model, ms = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    ms.input += split.input; ms.cacheRead += split.cacheRead; ms.cacheWrite += split.cacheWrite; ms.output += split.output;

    if (client != null) {
      const combo = role || "main";
      const edges = [[`combo:${combo}`, `provider:${provider}`], [`provider:${provider}`, `model:${provider}:${model}`]];
      for (const [source, target] of edges) {
        const lk = JSON.stringify([source, target]);
        let l = ddRoutes.get(lk);
        if (!l) ddRoutes.set(lk, l = { source, target, req: 0, v: 0, real: 0, realEst: 0, paid: PAID(provider) });
        l.req += rReq; l.v += costSum; l.real += realSum; l.realEst += realEstSum;
      }
    }

    const add = (m, k) => {
      const o = bump(m, k, () => ({ ...acc(), clients: {}, keys: {}, mix: {}, n: 0, provider: r.provider }));
      o.v += costSum; o.real += realSum; o.realEst += realEstSum; o.req += rReq; o.tok += tokSum;
      return o;
    };
    const ko = add(byKey, keyName);
    if (client) ko.clients[client] = (ko.clients[client] || 0) + costSum;
    const mo = add(byModel, model);
    mo.keys[keyName] = (mo.keys[keyName] || 0) + costSum;
    if (client) mo.clients[client] = (mo.clients[client] || 0) + costSum;
    add(byProv, provider);

    if (client) {
      add(byCombo, role);
      const co = add(byClient, client);
      co.mix[r.model] = (co.mix[r.model] || 0) + costSum;
      co.keys[keyName] = (co.keys[keyName] || 0) + costSum;
      if (r.sess) {
        const s = bump(bySess, r.sess, () => ({
          ...acc(), id: r.sess, client, role, key: keyName,
          start: r.startMs, end: r.endMs, models: new Map(), times: [],
        }));
        s.v += costSum; s.real += realSum; s.realEst += realEstSum; s.req += rReq; s.tok += tokSum;
        if (r.startMs < s.start) s.start = r.startMs;
        if (r.endMs > s.end) s.end = r.endMs;
        const sm = bump(s.models, r.model, () => ({ provider: r.provider, req: 0, v: 0, real: 0 }));
        sm.req += rReq; sm.v += costSum; sm.real += realSum;
      }
    } else {
      nrList += costSum; nrReq += rReq; nrTok += tokSum;
    }
  }

  // Build drilldown output matching createSpendDrilldown().result()
  const sortValue = (a, b) => b.v - a.v;
  const providerTree = [...ddProviders].map(([k, p]) => ({
    k, ...p,
    models: [...p.models].map(([mk, m]) => ({
      k: mk, ...m,
      efforts: [...m.efforts].map(([ek, v]) => ({ k: ek, ...v })).sort(sortValue),
    })).sort(sortValue),
  })).sort(sortValue);

  const routeNodes = new Map();
  for (const link of ddRoutes.values()) {
    routeNodes.set(link.source, { id: link.source, kind: link.source.startsWith("combo:") ? "combo" : "provider" });
    routeNodes.set(link.target, { id: link.target, kind: link.target.startsWith("provider:") ? "provider" : "model" });
  }
  const links = [...ddRoutes.values()];
  const modelReq = new Map();
  for (const link of links) if (link.target.startsWith("model:")) modelReq.set(link.source, (modelReq.get(link.source) || 0) + link.req);
  const mergeTargets = new Map();
  for (const [providerId] of modelReq) {
    const models = links.filter((link) => link.source === providerId && link.target.startsWith("model:")).sort((a, b) => b.req - a.req);
    for (const link of models.slice(25)) {
      const otherId = `${providerId}:other-models`;
      let aggregate = mergeTargets.get(otherId);
      if (!aggregate) mergeTargets.set(otherId, aggregate = { source: providerId, target: otherId, req: 0, v: 0, real: 0, realEst: 0, paid: link.paid });
      aggregate.req += link.req; aggregate.v += link.v; aggregate.real += link.real; aggregate.realEst += link.realEst;
      links.splice(links.indexOf(link), 1);
      routeNodes.delete(link.target);
    }
    if (mergeTargets.has(`${providerId}:other-models`)) routeNodes.set(`${providerId}:other-models`, { id: `${providerId}:other-models`, kind: "model" });
  }
  links.push(...mergeTargets.values());
  const tokenSplit = Object.fromEntries(ddModelSplits);
  const totalSplit = Object.values(tokenSplit).reduce(
    (a, x) => { a.input += x.input; a.cacheRead += x.cacheRead; a.cacheWrite += x.cacheWrite; a.output += x.output; return a; },
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );
  const drilldownData = { providerTree, tokenSplit, totalSplit, routes: { nodes: [...routeNodes.values()], links } };

  const pack = (m) => [...m.entries()].map(([k, o]) => ({
    k, v: o.v, real: o.real, realEst: o.realEst, req: o.req, tok: o.tok, n: o.n, provider: o.provider,
    clients: Object.entries(o.clients || {}).sort((a, b) => b[1] - a[1]).map((e) => e[0]),
    keys: Object.entries(o.keys || {}).sort((a, b) => b[1] - a[1]).map((e) => e[0]),
    mix: Object.entries(o.mix || {}).sort((a, b) => b[1] - a[1]),
  }));

  const roleCount = {};
  for (const s of bySess.values()) roleCount[s.role] = (roleCount[s.role] || 0) + 1;
  const sessions = [...bySess.values()].sort((a, b) => b.v - a.v);

  // Fetch up to 40 request timestamps ONLY for the top 200 displayed sessions.
  const top200 = sessions.slice(0, 200);
  if (top200.length > 0) {
    const sessIds = top200.map((s) => s.id);
    const minStart = Math.min(...top200.map((s) => s.start));
    const maxEnd = Math.max(...top200.map((s) => s.end)) + 1;
    const tickFromIso = new Date(Math.max(range.from, minStart)).toISOString();
    const tickToIso = new Date(Math.min(range.to, maxEnd)).toISOString();
    const tickWide = (Math.min(range.to, maxEnd) - Math.max(range.from, minStart)) >= 7 * DAY_MS;
    const tickTsWhere = tickWide ? "+timestamp >= ? AND +timestamp < ?" : "timestamp >= ? AND timestamp < ?";
    const ph = sessIds.map(() => "?").join(",");
    const tickRows = db.all(
      `SELECT
         COALESCE(NULLIF(session, ''), CASE WHEN ${META_VALID} AND json_type(meta, '$.session') = 'text' THEN NULLIF(json_extract(meta, '$.session'), '') END) AS sess,
         CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) AS ms
       FROM usageHistory
       WHERE ${tickTsWhere}
         AND (NULLIF(session, '') IS NOT NULL OR (meta LIKE '%"session"%' AND ${META_VALID} AND json_type(meta, '$.session') = 'text' AND json_extract(meta, '$.session') != ''))
         AND COALESCE(NULLIF(session, ''), CASE WHEN ${META_VALID} AND json_type(meta, '$.session') = 'text' THEN NULLIF(json_extract(meta, '$.session'), '') END) IN (${ph})
       ORDER BY id ASC`,
      [tickFromIso, tickToIso, ...sessIds],
    );
    for (const tr of tickRows) {
      const s = bySess.get(tr.sess);
      if (s && s.times.length < 40) s.times.push(tr.ms);
    }
  }

  const sessOut = top200.map((s) => ({
    id: s.id, client: s.client, role: s.role, key: s.key, start: s.start, end: s.end,
    startDay: fmtIstDay(s.start), startTime: fmtIstHhmm(s.start), endTime: fmtIstHhmm(s.end),
    isToday: istDayKey(s.start) === istDayKey(now), v: s.v, real: s.real, realEst: s.realEst, req: s.req, tok: s.tok,
    ticks: s.times.slice(0, 40).map((x) => (s.end > s.start ? (x - s.start) / (s.end - s.start) : 0.5)),
    models: [...s.models.entries()].sort((a, b) => b[1].v - a[1].v).map(([m, o]) => ({ m, ...o })),
  }));

  // Outliers (top 10 by list-price value and top 10 by real spend) via SQL ORDER BY + LIMIT 10
  const mapTopRow = (r) => {
    const meta = safeParseMeta(r.meta);
    const ms = Date.parse(r.timestamp);
    const keyName = keyNames.get(r.apiKey) || (r.apiKey ? "Unknown key" : "No key");
    const hasUa = meta.ua !== undefined;
    const client = safeClientOf(hasUa, meta.ua);
    const costVal = Number(r.v) || 0;
    const realVal = Number(r.realVal) || 0;
    const o = {
      ms, model: r.model, provider: r.provider, key: keyName,
      combo: meta.combo || "", client, sess: meta.session || null,
      tok: Number(r.tok) || 0, v: costVal, real: realVal, est: !!r.est, logged: !!client,
    };
    return { ...o, when: (istDayKey(o.ms) === istDayKey(now) ? "Today " : fmtIstDay(o.ms) + ", ") + fmtIstHhmm(o.ms) };
  };

  const validBarTs = `unixepoch(timestamp, 'subsec') IS NOT NULL AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) >= ? AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) < ?`;
  const topValRows = db.all(
    `SELECT id, timestamp, provider, model, apiKey, meta,
            ${COST_EXPR} AS v,
            ${REAL_EXPR} AS realVal,
            CASE WHEN ${REAL_SET} THEN 0 WHEN provider IN ('openrouter', 'deepseek') THEN 1 ELSE 0 END AS est,
            (COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)) AS tok
     FROM usageHistory
     WHERE ${tsWhere} AND ${validBarTs}
     ORDER BY v DESC, id ASC
     LIMIT 10`,
    [fromIso, toIso, range.from, range.to],
  );
  const topRealRows = db.all(
    `SELECT id, timestamp, provider, model, apiKey, meta,
            ${COST_EXPR} AS v,
            ${REAL_EXPR} AS realVal,
            CASE WHEN ${REAL_SET} THEN 0 WHEN provider IN ('openrouter', 'deepseek') THEN 1 ELSE 0 END AS est,
            (COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)) AS tok
     FROM usageHistory
     WHERE ${tsWhere} AND ${validBarTs} AND (${REAL_EXPR}) > 0
     ORDER BY realVal DESC, v DESC, id ASC
     LIMIT 10`,
    [fromIso, toIso, range.from, range.to],
  );
  const byValue = topValRows.map(mapTopRow);
  const byReal = topRealRows.map(mapTopRow);

  const topSessByBar = (b) => {
    const s = sessions.filter((x) => x.start >= b.t && x.start < b.t + step)[0];
    if (!s) return null;
    const rr = [...new Set(sessions.filter((x) => x.start >= b.t && x.start < b.t + step && x.real > 0).map((x) => x.role))];
    return { key: s.key, role: s.role, id: s.id, realVia: rr };
  };
  const topBars = bars.filter((b) => !b.future).map((b) => ({ ...b, tot: b.val + b.real })).sort((a, b) => b.tot - a.tot).slice(0, 5)
    .map((b) => ({
      label: b.label, val: b.val, real: b.real, tot: b.tot, logged: b.logged, top: topSessByBar(b),
      topKey: [...(b.keys || new Map()).entries()].sort((a, c) => c[1] - a[1])[0]?.[0] || null,
    }));

  const ds30 = db.get(`SELECT SUM(cost) AS c FROM usageHistory WHERE provider = 'deepseek' AND timestamp >= ?`, [new Date(now - 30 * DAY_MS).toISOString()]);

  const body = {
    now,
    clock, whatIfGroups: [...whatIfGroups.values()],
    range: { ...range, first: bars[0]?.label, last: [...bars].reverse().find((b) => !b.future)?.label, days: range.hourly ? 1 : nB },
    loggedSince,
    loggedSinceLabel: loggedSince ? fmtIstDay(loggedSince) : null,
    bars: bars.map(({ t, keys, ...b }) => b),
    totals: { value, real, realEst, list, req, tok, tokSplit: drilldownData.totalSplit, realOr, realDs, realDs30: ds30?.c || 0, subs, nrList, nrReq, nrTok },
    allLogged: loggedSince !== null && loggedSince <= range.from,
    subsMeta: SUBS,
    fees: fees || {},
    groups: {
      key: pack(byKey),
      model: pack(byModel),
      modelEffort: [...byModelEffort.values()].sort((a, b) => b.v - a.v),
      tokenSplit: drilldownData.tokenSplit,
      providerTree: drilldownData.providerTree,
      routes: drilldownData.routes,
      role: pack(byCombo),
      client: pack(byClient),
      provider: pack(byProv),
    },
    roleCount,
    sessionCount: sessions.length,
    sessionValue: sessions.reduce((a, s) => a + s.v, 0),
    sessionRest: sessions.slice(8).reduce((a, s) => ({ v: a.v + s.v, real: a.real + s.real, realEst: a.realEst + s.realEst, req: a.req + s.req, tok: a.tok + s.tok }), { v: 0, real: 0, realEst: 0, req: 0, tok: 0 }),
    sessionRest10: sessions.slice(10).reduce((a, s) => ({ v: a.v + s.v, real: a.real + s.real, realEst: a.realEst + s.realEst, req: a.req + s.req, tok: a.tok + s.tok }), { v: 0, real: 0, realEst: 0, req: 0, tok: 0 }),
    sessions: sessOut,
    outliers: { value: byValue, real: byReal },
    topBars,
  };

  if (!skipCache) {
    if (st.cache.size >= CACHE_MAX_ENTRIES) {
      const oldestKey = st.cache.keys().next().value;
      st.cache.delete(oldestKey);
    }
    st.cache.set(cacheKey, { ts: now, maxId, feesVersion, body });
  }
  return body;
}
