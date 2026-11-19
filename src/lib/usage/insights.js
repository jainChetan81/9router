// Usage page "Insights" tab: latency percentiles, combo fallback summary and
// filtered usage rows. Both queries read at most the newest INSIGHTS_SAMPLE_CAP
// rows of the time range (idx_uh_ts). The summary aggregates that window in JS.
// The row filters (combo, member, trace, tag) have no index, so they run only
// inside that window: a rare filter costs at most one pass over the window and
// misses older matches, which the result reports as `capped`.
import { getAdapter } from "../db/driver.js";
import { parseJson } from "../db/helpers/jsonCol.js";
import { percentile } from "../agents/percentiles.js";
import { istMidnightMs } from "../spend/time.js";

export const INSIGHT_PERIODS = ["today", "24h", "7d", "30d", "60d"];
export const INSIGHTS_SAMPLE_CAP = 20_000;
export const INSIGHT_ROWS_MAX = 200;

const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
const CACHE_TTL_MS = 15_000;
const OPTION_LIMIT = 50;
const FILTER_VALUE_MAX = 200;
const REASONS = ["rate_limit", "timeout", "empty", "error"];

// period -> { pending, at, promise }. Holding the promise lets concurrent cold
// requests share one query.
const summaryCache = new Map();

export function resolveInsightRange(period, now = Date.now()) {
  const key = INSIGHT_PERIODS.includes(period) ? period : "24h";
  const from = key === "today" ? istMidnightMs(now) : now - PERIOD_MS[key];
  // The upper bound sits just past "now" so rows written this second are included.
  return { period: key, fromIso: new Date(from).toISOString(), toIso: new Date(now + 1000).toISOString() };
}

const isOk = (status) => status === "ok" || status === "success";
const memberOf = (row) => `${row.provider || "unknown"}/${row.model || "unknown"}`;
const finite = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);
const metaOf = (row) => {
  const meta = parseJson(row.meta, null);
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
};
const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

// Latency of the upstream attempt that produced the row. Rows written before
// the attempt fields existed only have the request-scoped values, which also
// include earlier combo members and account retries.
function rowLatency(meta) {
  const latency = meta.latency && typeof meta.latency === "object" ? meta.latency : {};
  const attemptTotal = finite(latency.attemptTotalMs);
  if (attemptTotal != null) return { scope: "attempt", ttftMs: finite(latency.attemptTtftMs), totalMs: attemptTotal };
  return { scope: "request", ttftMs: finite(latency.ttftMs), totalMs: finite(latency.totalMs) };
}

function latencyStats(group) {
  return {
    count: group.totals.length,
    ttftCount: group.ttfts.length,
    ttftP50: percentile(group.ttfts, 50),
    ttftP95: percentile(group.ttfts, 95),
    totalP50: percentile(group.totals, 50),
    totalP95: percentile(group.totals, 95),
  };
}

function addLatency(map, key, labels, ttftMs, totalMs) {
  let group = map.get(key);
  if (!group) { group = { ...labels, ttfts: [], totals: [] }; map.set(key, group); }
  group.totals.push(totalMs);
  if (ttftMs != null) group.ttfts.push(ttftMs);
}

function topCounts(map, limit = OPTION_LIMIT) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit).map(([value, count]) => ({ value, count }));
}

function bump(map, key, by = 1) { map.set(key, (map.get(key) || 0) + by); }

function emptyMember(model) {
  return { model, served: 0, failed: 0, reasons: { rate_limit: 0, timeout: 0, empty: 0, error: 0 }, codes: {} };
}

/** Latency percentiles, combo fallback summary and filter options for one period. */
export function getUsageInsights(period) {
  const range = resolveInsightRange(period);
  const cached = summaryCache.get(range.period);
  if (cached && (cached.pending || Date.now() - cached.at < CACHE_TTL_MS)) return cached.promise;

  const entry = { pending: true, at: 0, promise: null };
  entry.promise = computeUsageInsights(range).then(
    (value) => {
      entry.pending = false;
      entry.at = Date.now();
      return value;
    },
    (error) => {
      if (summaryCache.get(range.period) === entry) summaryCache.delete(range.period);
      throw error;
    }
  );
  summaryCache.set(range.period, entry);
  return entry.promise;
}

async function computeUsageInsights(range) {
  const db = await getAdapter();
  // One column read per row; meta is parsed once in JS below.
  const rows = db.all(
    `SELECT provider, model, status, meta
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`,
    [range.fromIso, range.toIso, INSIGHTS_SAMPLE_CAP]
  );

  const byModel = new Map();
  const byComboMember = new Map();
  const traceNames = new Map();
  const tagCounts = new Map();
  const statusCounts = new Map();
  const comboRequests = new Map(); // combo -> Map(request key -> { attempts, okMembers })
  let okRows = 0;
  let withLatency = 0;
  let withTtft = 0;
  let attemptScoped = 0;

  rows.forEach((row, index) => {
    const meta = metaOf(row);
    const member = memberOf(row);
    const comboName = typeof meta.combo === "string" && meta.combo ? meta.combo : null;
    // The last combo member answered with an empty 200. Its row has status
    // "ok" but nothing was served, so it counts as neither served nor timed.
    const emptyFinal = meta.comboEmptyFinal === true;
    const ok = isOk(row.status) && !emptyFinal;
    bump(statusCounts, isOk(row.status) ? "ok" : String(row.status || "error"));
    if (typeof meta.trace?.name === "string" && meta.trace.name) bump(traceNames, meta.trace.name);
    for (const tag of stringList(meta.trace?.tags)) bump(tagCounts, tag);

    // Latency covers served requests only. A failed row has no model latency.
    if (ok) {
      okRows++;
      const { scope, ttftMs, totalMs } = rowLatency(meta);
      if (totalMs != null) {
        withLatency++;
        if (scope === "attempt") attemptScoped++;
        if (ttftMs != null) withTtft++;
        addLatency(byModel, member, { provider: row.provider || "unknown", model: row.model || "unknown" }, ttftMs, totalMs);
        if (comboName) addLatency(byComboMember, `${comboName}\u0000${member}`, { combo: comboName, member }, ttftMs, totalMs);
      }
    }

    if (comboName) {
      let requests = comboRequests.get(comboName);
      if (!requests) { requests = new Map(); comboRequests.set(comboName, requests); }
      // Rows of one client request share a reqId. Older rows have none.
      const key = meta.reqId ? String(meta.reqId) : `row:${index}`;
      let request = requests.get(key);
      if (!request) { request = { attempts: [], okMembers: [] }; requests.set(key, request); }
      const attempts = meta.comboAttempts;
      // Each row carries the attempts seen so far; the longest list is complete.
      if (Array.isArray(attempts) && attempts.length > request.attempts.length) request.attempts = attempts;
      if (ok) request.okMembers.push(member);
    }
  });

  const combos = [];
  for (const [combo, requests] of comboRequests) {
    const members = new Map();
    const memberFor = (model) => {
      let entry = members.get(model);
      if (!entry) { entry = emptyMember(model); members.set(model, entry); }
      return entry;
    };
    let served = 0;
    let fellBack = 0;
    let failed = 0;
    for (const request of requests.values()) {
      const failedModels = new Set();
      for (const attempt of request.attempts) {
        if (!attempt || typeof attempt.model !== "string") continue;
        failedModels.add(attempt.model);
        const entry = memberFor(attempt.model);
        entry.failed++;
        entry.reasons[REASONS.includes(attempt.reason) ? attempt.reason : "error"]++;
        if (Number.isInteger(attempt.status)) entry.codes[attempt.status] = (entry.codes[attempt.status] || 0) + 1;
      }
      // A member that returned an empty answer wrote an "ok" row but did not serve.
      // (A final empty member is already left out of okMembers by its marker.)
      const servers = request.okMembers.filter((model) => !failedModels.has(model));
      for (const model of servers) memberFor(model).served++;
      if (servers.length) {
        served++;
        if (failedModels.size) fellBack++;
      } else failed++;
    }
    const memberList = [...members.values()].map((entry) => ({
      ...entry,
      codes: Object.entries(entry.codes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, count]) => ({ code: Number(code), count })),
      fallbackRate: entry.served + entry.failed ? entry.failed / (entry.served + entry.failed) : 0,
    })).sort((a, b) => (b.served + b.failed) - (a.served + a.failed) || a.model.localeCompare(b.model));
    combos.push({
      combo,
      requests: requests.size,
      served,
      fellBack,
      failed,
      fallbackRate: requests.size ? (fellBack + failed) / requests.size : 0,
      members: memberList,
    });
  }
  combos.sort((a, b) => b.requests - a.requests || a.combo.localeCompare(b.combo));

  const sortLatency = (list) => list.sort((a, b) => b.count - a.count);
  const value = {
    period: range.period,
    from: range.fromIso,
    to: range.toIso,
    sampled: { rows: rows.length, cap: INSIGHTS_SAMPLE_CAP, capped: rows.length >= INSIGHTS_SAMPLE_CAP },
    latency: {
      okRows,
      withLatency,
      withTtft,
      // Rows timed from the start of their own upstream attempt. The rest are
      // older rows, timed from the start of the client request.
      attemptScoped,
      byModel: sortLatency([...byModel.values()].map(({ ttfts, totals, ...labels }) => ({ ...labels, ...latencyStats({ ttfts, totals }) }))),
      byComboMember: sortLatency([...byComboMember.values()].map(({ ttfts, totals, ...labels }) => ({ ...labels, ...latencyStats({ ttfts, totals }) }))),
    },
    combos,
    options: {
      combos: combos.map((entry) => ({ value: entry.combo, members: entry.members.map((member) => member.model) })),
      statuses: topCounts(statusCounts),
      traces: topCounts(traceNames),
      tags: topCounts(tagCounts),
    },
  };
  return value;
}

// One malformed meta value must not make the JSON filters throw.
const SAFE_META = "CASE WHEN json_valid(meta) THEN meta ELSE '{}' END";

function filterValue(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, FILTER_VALUE_MAX) : null;
}

/**
 * Newest usage rows in the period that match the filters (at most INSIGHT_ROWS_MAX).
 * Only the newest INSIGHTS_SAMPLE_CAP rows of the period are searched; `capped`
 * says the period holds more than that, so older matches may be missing.
 */
export async function getUsageInsightRows({ period, combo, member, status, trace, tag, limit } = {}) {
  const range = resolveInsightRange(period);
  const conds = [];
  const params = [];

  const comboFilter = filterValue(combo);
  const memberFilter = filterValue(member);
  const statusFilter = filterValue(status);
  const traceFilter = filterValue(trace);
  const tagFilter = filterValue(tag);

  if (comboFilter) { conds.push(`json_extract(${SAFE_META}, '$.combo') = ?`); params.push(comboFilter); }
  if (memberFilter) {
    // A member matches the row it served and the rows where it failed first.
    conds.push(`((COALESCE(provider, 'unknown') || '/' || COALESCE(model, 'unknown')) = ?
      OR EXISTS (SELECT 1 FROM json_each(${SAFE_META}, '$.comboAttempts') WHERE json_extract(value, '$.model') = ?))`);
    params.push(memberFilter, memberFilter);
  }
  if (statusFilter === "ok") conds.push("status IN ('ok', 'success')");
  else if (statusFilter === "error") conds.push("(status IS NULL OR status NOT IN ('ok', 'success'))");
  else if (statusFilter) { conds.push("status = ?"); params.push(statusFilter); }
  if (traceFilter) { conds.push(`json_extract(${SAFE_META}, '$.trace.name') = ?`); params.push(traceFilter); }
  if (tagFilter) { conds.push(`EXISTS (SELECT 1 FROM json_each(${SAFE_META}, '$.trace.tags') WHERE value = ?)`); params.push(tagFilter); }

  const max = Math.max(1, Math.min(INSIGHT_ROWS_MAX, Number.parseInt(limit, 10) || INSIGHT_ROWS_MAX));
  const db = await getAdapter();
  // The inner query takes the newest window through idx_uh_ts. Its LIMIT stops
  // SQLite from merging it into the outer query, so the unindexed JSON filters
  // run on at most INSIGHTS_SAMPLE_CAP rows however rare a match is.
  const rows = db.all(
    `SELECT id, timestamp, provider, model, status, promptTokens, completionTokens, cost, meta
     FROM (
       SELECT id, timestamp, provider, model, status, promptTokens, completionTokens, cost, meta
       FROM usageHistory
       WHERE timestamp >= ? AND timestamp < ?
       ORDER BY timestamp DESC, id DESC
       LIMIT ?
     )
     ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`,
    [range.fromIso, range.toIso, INSIGHTS_SAMPLE_CAP, ...params, max + 1]
  );
  // Index-only count that stops just past the cap.
  const windowCount = Number(db.get(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM usageHistory WHERE timestamp >= ? AND timestamp < ? LIMIT ?)`,
    [range.fromIso, range.toIso, INSIGHTS_SAMPLE_CAP + 1]
  )?.n) || 0;

  return {
    period: range.period,
    limit: max,
    hasMore: rows.length > max,
    searched: Math.min(windowCount, INSIGHTS_SAMPLE_CAP),
    cap: INSIGHTS_SAMPLE_CAP,
    capped: windowCount > INSIGHTS_SAMPLE_CAP,
    rows: rows.slice(0, max).map((row) => {
      const meta = metaOf(row);
      const latency = rowLatency(meta);
      return {
        id: row.id,
        timestamp: row.timestamp,
        provider: row.provider || "unknown",
        model: row.model || "unknown",
        status: isOk(row.status) ? "ok" : String(row.status || "error"),
        errorKind: typeof meta.errorKind === "string" ? meta.errorKind : null,
        emptyFinal: meta.comboEmptyFinal === true,
        promptTokens: Number(row.promptTokens) || 0,
        completionTokens: Number(row.completionTokens) || 0,
        cost: Number(row.cost) || 0,
        combo: typeof meta.combo === "string" && meta.combo ? meta.combo : null,
        ttftMs: latency.ttftMs,
        totalMs: latency.totalMs,
        latencyScope: latency.scope,
        attempts: Array.isArray(meta.comboAttempts) ? meta.comboAttempts.filter((attempt) => attempt && typeof attempt === "object") : [],
        trace: typeof meta.trace?.name === "string" && meta.trace.name ? meta.trace.name : null,
        tags: stringList(meta.trace?.tags),
      };
    }),
  };
}
