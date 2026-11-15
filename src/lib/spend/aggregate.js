import { clientOf } from "../spendClient.js";
import { PAID } from "./drilldown.js";
import { version as liveVersion } from "../live/bus.js";
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
const DAY_CACHE_MAX = 60; // cached closed IST days per adapter
const TODAY_REFRESH_MIN_MS = 10_000; // today's partial slice recomputes at most this often
const SESSION_OUT_CAP = 100; // sessions sent to the client (was 200)
const TICK_CAP = 24; // timeline dots per session (was 40)
const adapterState = new WeakMap();
let feesVersion = 0;

function getState(db) {
  let st = adapterState.get(db);
  if (!st) {
    st = { meta: null, cache: new Map(), days: new Map(), today: null, todayAt: 0 };
    adapterState.set(db, st);
  }
  return st;
}

export function invalidateSpendCache(db) {
  feesVersion++;
  if (db) {
    const st = adapterState.get(db);
    if (st) { st.cache.clear(); st.days.clear(); st.today = null; }
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
const RS_EXPR = `MAX(0, COALESCE(CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.reasoning_tokens'), '') END, 0))`;
const OUT_EXPR = `MAX(0, COALESCE(CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.completion_tokens'), '') END, CASE WHEN ${TOK_VALID} THEN NULLIF(json_extract(tokens, '$.output_tokens'), '') END, completionTokens, 0))`;

// Wide ranges (>= 7 days) scan sequentially; narrow ranges use idx_uh_ts lookups.
const tsWhereFor = (from, to) => ((to - from) >= 7 * DAY_MS ? "+timestamp >= ? AND +timestamp < ?" : "timestamp >= ? AND timestamp < ?");

// The GROUP BY select list shared by the whole-range and per-day slice queries.
const GROUP_DIMS = `
  provider,
  model,
  apiKey,
  CASE WHEN ${META_VALID} AND json_type(meta, '$.ua') IS NOT NULL THEN 1 ELSE 0 END AS hasUa,
  CASE WHEN ${META_VALID} THEN json_extract(meta, '$.ua') ELSE NULL END AS ua,
  CASE WHEN ${META_VALID} AND json_type(meta, '$.combo') = 'text' THEN NULLIF(json_extract(meta, '$.combo'), '') ELSE NULL END AS combo,
  CASE WHEN ${META_VALID} AND json_type(meta, '$.sentEffort') = 'text' THEN NULLIF(json_extract(meta, '$.sentEffort'), '') ELSE NULL END AS effort,
  COALESCE(NULLIF(session, ''), CASE WHEN ${META_VALID} AND json_type(meta, '$.session') = 'text' THEN NULLIF(json_extract(meta, '$.session'), '') END) AS sess`;

const GROUP_AGGS = `
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
  SUM(${OUT_EXPR}) AS outSum,
  SUM(${RS_EXPR}) AS rsSum`;

const CLOCK_SQL = `SELECT CAST(strftime('%w', timestamp, '+5 hours', '+30 minutes') AS INTEGER) AS weekday,
  CAST(strftime('%H', timestamp, '+5 hours', '+30 minutes') AS INTEGER) AS hour,
  COUNT(*) AS req, SUM(${COST_EXPR}) AS cost
  FROM usageHistory WHERE TSWHERE AND unixepoch(timestamp, 'subsec') IS NOT NULL
  GROUP BY 1, 2`;

const OUTLIER_COLS = `provider, model, apiKey, meta,
  ${COST_EXPR} AS v,
  ${REAL_EXPR} AS realVal,
  CASE WHEN ${REAL_SET} THEN 0 WHEN provider IN ('openrouter', 'deepseek') THEN 1 ELSE 0 END AS est,
  (COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)) AS tok`;

function queryDaySlice(db, dayFrom) {
  const fromIso = new Date(dayFrom).toISOString();
  const toIso = new Date(dayFrom + DAY_MS).toISOString();
  const w = tsWhereFor(dayFrom, dayFrom + DAY_MS);
  const rows = db.all(
    `SELECT ${GROUP_DIMS}, ${GROUP_AGGS} FROM usageHistory WHERE ${w} GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`,
    [fromIso, toIso],
  );
  const dayClock = db.all(CLOCK_SQL.replace("TSWHERE", w), [fromIso, toIso]);
  const topVal = db.all(
    `SELECT ${OUTLIER_COLS} FROM usageHistory WHERE ${w}
       AND unixepoch(timestamp, 'subsec') IS NOT NULL
       AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) >= ? AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) < ?
     ORDER BY v DESC, id ASC LIMIT 20`,
    [fromIso, toIso, dayFrom, dayFrom + DAY_MS],
  );
  const topReal = db.all(
    `SELECT ${OUTLIER_COLS} FROM usageHistory WHERE ${w}
       AND unixepoch(timestamp, 'subsec') IS NOT NULL
       AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) >= ? AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) < ?
       AND (${REAL_EXPR}) > 0
     ORDER BY realVal DESC, v DESC, id ASC LIMIT 20`,
    [fromIso, toIso, dayFrom, dayFrom + DAY_MS],
  );
  // Session timeline dots: all request timestamps of logged sessions in this
  // day. Sessions later pick the dots of the top SESSION_OUT_CAP sessions.
  const ticks = db.all(
    `SELECT
       COALESCE(NULLIF(session, ''), CASE WHEN ${META_VALID} AND json_type(meta, '$.session') = 'text' THEN NULLIF(json_extract(meta, '$.session'), '') END) AS sess,
       CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) AS ms
     FROM usageHistory WHERE ${w}
       AND (NULLIF(session, '') IS NOT NULL OR (meta LIKE '%"session"%' AND ${META_VALID} AND json_type(meta, '$.session') = 'text' AND json_extract(meta, '$.session') != ''))
     ORDER BY id ASC`,
    [fromIso, toIso],
  );
  return { rows, dayClock, topVal, topReal, ticks };
}

// Closed IST days are immutable: cache each day's slice per adapter and merge
// it into any daily range that contains it. Today's partial slice recomputes
// when the usage topic version changes (throttled) or new rows land.
// `fresh` (a sync request) recomputes today's partial day whatever its age.
// Closed days stay cached either way: they cannot change.
function daySlice(db, st, dayFrom, { today = false, maxId = null, fresh = false, usageVersion } = {}) {
  if (today) {
    // In the Spend worker thread the bus is a separate copy that never bumps,
    // so the caller passes the main-thread version in.
    const topicVersion = usageVersion ?? liveVersion("usage");
    if (!fresh && st.today && st.today.dayFrom === dayFrom && st.today.topicVersion === topicVersion
      && st.today.maxId === maxId && (Date.now() - st.todayAt) < TODAY_REFRESH_MIN_MS) return st.today;
    const slice = queryDaySlice(db, dayFrom);
    st.today = { ...slice, dayFrom, topicVersion, maxId };
    st.todayAt = Date.now();
    return st.today;
  }
  const key = dayFrom;
  const hit = st.days.get(key);
  if (hit) {
    st.days.delete(key);
    st.days.set(key, hit); // refresh LRU order
    return hit;
  }
  const slice = queryDaySlice(db, dayFrom);
  if (st.days.size >= DAY_CACHE_MAX) {
    st.days.delete(st.days.keys().next().value);
  }
  st.days.set(key, slice);
  return slice;
}

// `skipCache` (a sync request, and tests): no body cache, no cached range
// metadata, and today's slice is recomputed. Closed-day slices are still
// reused; an IST day that has ended is immutable.
export function aggregateSpend(db, { params, now = Date.now(), fees = {}, skipCache = false, usageVersion } = {}) {
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
  const feeSig = SUBS.map((s) => `${s.k}=${fees?.[s.k] ?? ""}`).join("&");
  const halfHourBucket = Math.floor(now / 18e5);
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

  // Aggregation accumulators shared by every slice merged into this range.
  const whatIfGroups = new Map();
  const byKey = new Map(), byModel = new Map(), byModelEffort = new Map();
  const byCombo = new Map(), byClient = new Map(), bySess = new Map(), byProv = new Map();
  const ddProviders = new Map(), ddModelSplits = new Map(), ddRoutes = new Map();
  const subs = Object.fromEntries(SUBS.map((s) => [s.k, 0]));
  let value = 0, real = 0, realEst = 0, list = 0, req = 0, tok = 0, realOr = 0, realDs = 0, nrList = 0, nrReq = 0, nrTok = 0;
  const clock = new Map(); // "weekday:hour" -> { weekday, hour, req, cost }
  const outlierRawVal = [], outlierRawReal = []; // per-day top lists, re-ranked after the merge
  const allTicks = []; // per-day session tick rows { sess, ms } in id order
  const keyNames = new Map(db.all(`SELECT key, name FROM apiKeys`).map((r) => [r.key, r.name]));

  // One pass over one slice's GROUP BY rows. barStart maps a row to its bar:
  // a constant (one daily bar per day slice) or derived from a barIdx column.
  function processRows(rows, barStartOf) {
    for (const r of rows) {
      const barIdx = Math.floor((barStartOf(r) - range.from) / step);
      const b = barIdx >= 0 && barIdx < bars.length ? bars[barIdx] : null;
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
        reasoning: Number(r.rsSum) || 0,
      };

      for (const [kind, name] of [["model", r.model], ["combo", r.hasUa ? (r.combo || "main") : null]]) {
        if (!name) continue;
        const id = JSON.stringify([kind, name]);
        let group = whatIfGroups.get(id);
        if (!group) whatIfGroups.set(id, group = { kind, name, cost: 0, req: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
        group.cost += costSum; group.req += rReq;
        for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning"]) group[key] += split[key];
      }

      const provider = r.provider || "unknown";
      const model = r.model || "unknown";
      const effort = r.effort || "Unknown";
      const keyName = keyNames.get(r.apiKey) || (r.apiKey ? "Unknown key" : "No key");

      // Model + effort (matches addModelEffortUsage totals)
      const meKey = JSON.stringify([model, effort]);
      let me = byModelEffort.get(meKey);
      if (!me) {
        me = { k: `${model} · ${effort}`, model, effort, v: 0, real: 0, realEst: 0, req: 0, tok: 0 };
        byModelEffort.set(meKey, me);
      }
      me.v += costSum; me.real += realSum; me.realEst += realEstSum; me.req += rReq; me.tok += tokSum;

      // Bars & top-level totals
      if (b) {
        b.list += costSum;
        b.real += realSum;
        (b.keys ||= new Map()).set(keyName, (b.keys.get(keyName) || 0) + costSum);
        const sk = SUB_OF[r.provider];
        if (sk) {
          b.val += costSum;
          b.subs[sk] = (b.subs[sk] || 0) + costSum;
          subs[sk] += costSum;
          value += costSum;
        }
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
            start: r.startMs, end: r.endMs, models: new Map(),
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
  }

  const mergeClock = (dayClock) => {
    for (const c of dayClock) {
      const k = `${Number(c.weekday)}:${Number(c.hour)}`;
      const cur = clock.get(k);
      if (cur) { cur.req += Number(c.req) || 0; cur.cost += Number(c.cost) || 0; }
      else clock.set(k, { weekday: Number(c.weekday), hour: Number(c.hour), req: Number(c.req) || 0, cost: Number(c.cost) || 0 });
    }
  };

  const today0 = istMidnightMs(now);

  if (!range.hourly) {
    // Daily range: every IST day before today is closed and immutable, so its
    // slice is cached per (day) and merged in. Only today's partial day
    // recomputes, throttled by the usage topic version.
    for (let t = range.from; t < Math.min(range.to, today0); t += DAY_MS) {
      const slice = daySlice(db, st, t);
      processRows(slice.rows, () => t);
      mergeClock(slice.dayClock);
      outlierRawVal.push(...slice.topVal);
      outlierRawReal.push(...slice.topReal);
      allTicks.push(...slice.ticks);
    }
    if (today0 < range.to) {
      const slice = daySlice(db, st, today0, { today: true, maxId, fresh: skipCache, usageVersion });
      processRows(slice.rows, () => today0);
      mergeClock(slice.dayClock);
      outlierRawVal.push(...slice.topVal);
      outlierRawReal.push(...slice.topReal);
      allTicks.push(...slice.ticks);
    }
  } else {
    // Hourly ranges (Today, 24h): one whole-range slice as before.
    const fromIso = new Date(range.from).toISOString();
    const toIso = new Date(range.to).toISOString();
    const w = tsWhereFor(range.from, range.to);
    const mainRows = db.all(
      `SELECT
         CASE
           WHEN unixepoch(timestamp, 'subsec') IS NULL THEN -1
           WHEN CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) < ? THEN -1
           ELSE CAST((CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) - ?) / ? AS INTEGER)
         END AS barIdx,
         ${GROUP_DIMS},
         ${GROUP_AGGS}
       FROM usageHistory
       WHERE ${w}
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`,
      [range.from, range.from, step, fromIso, toIso],
    );
    processRows(mainRows, (r) => range.from + r.barIdx * step);
    const hourClock = db.all(CLOCK_SQL.replace("TSWHERE", w), [fromIso, toIso]);
    mergeClock(hourClock);
    outlierRawVal.push(...db.all(
      `SELECT ${OUTLIER_COLS} FROM usageHistory WHERE ${w} AND unixepoch(timestamp, 'subsec') IS NOT NULL
         AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) >= ? AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) < ?
       ORDER BY v DESC, id ASC LIMIT 10`,
      [fromIso, toIso, range.from, range.to],
    ));
    outlierRawReal.push(...db.all(
      `SELECT ${OUTLIER_COLS} FROM usageHistory WHERE ${w} AND unixepoch(timestamp, 'subsec') IS NOT NULL
         AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) >= ? AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) < ?
         AND (${REAL_EXPR}) > 0
       ORDER BY realVal DESC, v DESC, id ASC LIMIT 10`,
      [fromIso, toIso, range.from, range.to],
    ));
    allTicks.push(...db.all(
      `SELECT
         COALESCE(NULLIF(session, ''), CASE WHEN ${META_VALID} AND json_type(meta, '$.session') = 'text' THEN NULLIF(json_extract(meta, '$.session'), '') END) AS sess,
         CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000.0) AS INTEGER) AS ms
       FROM usageHistory
       WHERE ${w}
         AND (NULLIF(session, '') IS NOT NULL OR (meta LIKE '%"session"%' AND ${META_VALID} AND json_type(meta, '$.session') = 'text' AND json_extract(meta, '$.session') != ''))
       ORDER BY id ASC`,
      [fromIso, toIso],
    ));
  }

  // Build drilldown output matching createSpendDrilldown().result()
  const sortValue = (a, b) => b.v - a.v;
  const MODEL_TREE_CAP = 40, EFFORT_TREE_CAP = 6;
  const providerTree = [...ddProviders].map(([k, p]) => ({
    k, ...p,
    models: [...p.models].map(([mk, m]) => ({
      k: mk, ...m,
      efforts: [...m.efforts].map(([ek, v]) => ({ k: ek, ...v })).sort(sortValue).slice(0, EFFORT_TREE_CAP),
    })).sort(sortValue).slice(0, MODEL_TREE_CAP),
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

  const capEntries = (obj, cap) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, cap);

  const pack = (m) => [...m.entries()].map(([k, o]) => ({
    k, v: o.v, real: o.real, realEst: o.realEst, req: o.req, tok: o.tok, n: o.n, provider: o.provider,
    clients: capEntries(o.clients, 8).map((e) => e[0]),
    keys: capEntries(o.keys, 6).map((e) => e[0]),
    mix: capEntries(o.mix, 8),
  }));

  const roleCount = {};
  for (const s of bySess.values()) roleCount[s.role] = (roleCount[s.role] || 0) + 1;
  const sessions = [...bySess.values()].sort((a, b) => b.v - a.v);

  // Session timeline dots come from each day slice's tick list (cached with
  // the slice, so a warm range merge needs no extra query). Sessions keep
  // their first TICK_CAP dots in id order across merged days.
  const topSess = sessions.slice(0, SESSION_OUT_CAP);
  const topSessSet = new Set(topSess.map((s) => s.id));
  const sessTickIds = new Set();
  for (const tr of allTicks) {
    if (!topSessSet.has(tr.sess) || sessTickIds.has(tr.sess)) continue;
    const s = bySess.get(tr.sess);
    if (!s) continue;
    (s.times ||= []).push(tr.ms);
    sessTickIds.add(tr.sess);
    if (s.times.length >= TICK_CAP) sessTickIds.delete(tr.sess);
  }

  const sessOut = topSess.map((s) => ({
    id: s.id, client: s.client, role: s.role, key: s.key, start: s.start, end: s.end,
    startDay: fmtIstDay(s.start), startTime: fmtIstHhmm(s.start), endTime: fmtIstHhmm(s.end),
    isToday: istDayKey(s.start) === istDayKey(now), v: s.v, real: s.real, req: s.req, tok: s.tok,
    ticks: (s.times || []).map((x) => (s.end > s.start ? (x - s.start) / (s.end - s.start) : 0.5)),
    models: [...s.models.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 8).map(([m, o]) => ({ m, ...o })),
  }));

  // Outliers (top 10 by list-price value and top 10 by real spend).
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

  const byValue = outlierRawVal.map(mapTopRow).sort((a, b) => b.v - a.v || a.ms - b.ms).slice(0, 10);
  const byReal = outlierRawReal.map(mapTopRow).sort((a, b) => b.real - a.real || b.v - a.v || a.ms - b.ms).slice(0, 10);

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
    clock: [...clock.values()],
    whatIfGroups: [...whatIfGroups.values()],
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
