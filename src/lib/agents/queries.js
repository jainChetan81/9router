import { Worker } from "node:worker_threads";
import { getAdapter } from "../db/driver.js";
import { DATA_FILE } from "../db/paths.js";
import { parseJson } from "../db/helpers/jsonCol.js";
import { hasSessionColumn, sessionSql, sessionMatchSql, statusSql, roleSql } from "./dbColumns.js";
import { parseMeta, roleOf, clientOfUa, latencyOf, statusOf, bgRole } from "./meta.js";
import { num } from "./value.js";
import { percentile } from "./percentiles.js";
import { snapshot as liveSnapshot } from "./liveRegistry.js";

export async function getDb() { return getAdapter(); }

const FILE_BACKED_DRIVERS = new Set(["better-sqlite3", "node:sqlite", "bun:sqlite"]);
const READ_WORKER_LIMIT = 2;
const READ_QUEUE_LIMIT = 20;
const READ_JOB_TIMEOUT_MS = 5000;
const READ_WORKER_IDLE_MS = 60_000;
const readWorkers = [];
const pendingReadJobs = [];
const inFlightReadJobs = new Map();
let nextReadJobId = 1;
let readWorkerDriver = null;

class AgentsReadBusyError extends Error {
  constructor() {
    super("Agents read queue is busy");
    this.name = "AgentsReadBusyError";
    this.code = "busy";
    this.status = 503;
  }
}

function jobKey(db, method, args) {
  return JSON.stringify([DATA_FILE, db.driver, method, args]);
}

function settleReadJob(job, error, result) {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timeout);
  inFlightReadJobs.delete(job.key);
  if (error) job.reject(error);
  else job.resolve(result);
}

function retireReadWorker(slot, error = null) {
  if (slot.removed) return;
  slot.removed = true;
  slot.retired = true;
  clearTimeout(slot.idleTimer);
  clearTimeout(slot.job?.timeout);
  if (slot.job) {
    settleReadJob(slot.job, error || new Error("Agents read worker exited"));
    slot.job = null;
  }
  const index = readWorkers.indexOf(slot);
  if (index !== -1) readWorkers.splice(index, 1);
  drainReadJobs();
}

function armWorkerIdle(slot) {
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (slot.job || slot.retired) return;
    slot.worker.terminate().catch(() => {});
  }, READ_WORKER_IDLE_MS);
  slot.idleTimer.unref?.();
}

function createReadWorker() {
  const worker = new Worker(new URL("./readWorker.mjs", import.meta.url), {
    workerData: { file: DATA_FILE, driver: readWorkerDriver },
  });
  const slot = { worker, ready: false, retired: false, job: null, idleTimer: null };
  readWorkers.push(slot);
  worker.on("message", (message) => {
    if (message?.ready === false) {
      const error = new Error(message.error?.message || "Agents read worker failed to open the database");
      if (slot.job && !slot.job.settled) {
        clearTimeout(slot.job.timeout);
        pendingReadJobs.unshift(slot.job);
        slot.job = null;
      }
      retireReadWorker(slot);
      slot.worker.terminate().catch(() => {});
      // Keep the failure detail available when replacement capacity is exhausted.
      if (pendingReadJobs.length && readWorkers.length >= READ_WORKER_LIMIT) {
        const job = pendingReadJobs.shift();
        settleReadJob(job, error);
      }
      return;
    }
    if (message?.ready) {
      slot.ready = true;
      armWorkerIdle(slot);
      drainReadJobs();
      return;
    }
    const job = slot.job;
    if (!job || message?.id !== job.id) return;
    slot.job = null;
    clearTimeout(job.timeout);
    if (message?.error) {
      const error = new Error(message.error.message || "Agents read worker failed");
      if (message.error.stack) error.stack = message.error.stack;
      settleReadJob(job, error);
    } else settleReadJob(job, null, message?.result);
    armWorkerIdle(slot);
    drainReadJobs();
  });
  worker.on("error", (error) => retireReadWorker(slot, error));
  worker.on("exit", (code) => retireReadWorker(slot, code === 0 ? new Error("Agents read worker exited") : new Error(`Agents read worker exited with code ${code}`)));
  return slot;
}

function dispatchReadJob(slot, job) {
  clearTimeout(slot.idleTimer);
  slot.job = job;
  job.timeout = setTimeout(() => {
    if (slot.job !== job) return;
    slot.job = null;
    settleReadJob(job, new Error("Agents read job timed out"));
    slot.retired = true;
    slot.worker.terminate().catch(() => {}).finally(drainReadJobs);
  }, READ_JOB_TIMEOUT_MS);
  job.timeout.unref?.();
  slot.worker.postMessage({ id: job.id, method: job.method, args: job.args });
}

function drainReadJobs() {
  while (pendingReadJobs.length) {
    let slot = readWorkers.find((candidate) => candidate.ready && !candidate.job && !candidate.retired);
    if (!slot) {
      if (readWorkers.length >= READ_WORKER_LIMIT) return;
      try { slot = createReadWorker(); }
      catch (error) {
        const job = pendingReadJobs.shift();
        settleReadJob(job, error);
        continue;
      }
    }
    dispatchReadJob(slot, pendingReadJobs.shift());
  }
}

function runReadWorker(db, method, args, inline) {
  if (!FILE_BACKED_DRIVERS.has(db?.driver)) return inline();
  const key = jobKey(db, method, args);
  const current = inFlightReadJobs.get(key);
  if (current) return current.promise;
  if (pendingReadJobs.length >= READ_QUEUE_LIMIT) {
    return Promise.reject(new AgentsReadBusyError());
  }
  const job = { id: nextReadJobId++, db, method, args, key, settled: false };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  inFlightReadJobs.set(key, job);
  pendingReadJobs.push(job);
  readWorkerDriver = db.driver;
  drainReadJobs();
  return job.promise;
}

export function parseMetaSafe(raw) { return parseMeta(raw); }

export async function fetchRowsInRange(db, fromIso, toIso, extraWhere = "", extraParams = []) {
  const has = hasSessionColumn(db);
  const sql = `SELECT id, timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, meta${has ? ", session" : ""} FROM usageHistory WHERE timestamp >= ? AND timestamp < ? ${extraWhere} ORDER BY id ASC`;
  const rows = db.all(sql, [fromIso, toIso, ...extraParams]);
  return rows.map((r) => normalizeRow(r, has));
}

export function normalizeRow(r, hasCol) {
  const meta = parseMeta(r.meta);
  const sess = hasCol ? (r.session != null ? r.session : meta?.session) : meta?.session;
  const la = latencyOf(meta);
  const st = statusOf(meta, r.status);
  const client = clientOfUa(meta?.ua);
  const roleRaw = roleOf(meta);
  const role = bgRole(client, roleRaw);
  return {
    id: r.id,
    ts: r.timestamp,
    tsMs: Date.parse(r.timestamp),
    provider: r.provider || null,
    model: r.model || null,
    apiKey: r.apiKey || null,
    promptTokens: r.promptTokens || 0,
    completionTokens: r.completionTokens || 0,
    tokens: (r.promptTokens || 0) + (r.completionTokens || 0),
    cost: num(r.cost),
    value: num(r.cost),
    statusCol: r.status || null,
    meta,
    session: sess != null ? String(sess) : null,
    client,
    role,
    roleRaw,
    combo: meta?.combo || null,
    ua: meta?.ua || null,
    ttftMs: la.ttftMs,
    totalMs: la.totalMs,
    stream: la.stream,
    status: st,
    reqId: meta?.reqId || null,
  };
}

export async function distinctFirstMs(db) {
  const r = db.get("SELECT MIN(timestamp) AS t FROM usageHistory");
  return r?.t ? Date.parse(r.t) : Date.now();
}

const SUBAGENT_ROLES = new Set(["scout", "implementer", "reviewer", "background"]);
function isMainRole(role) { return !SUBAGENT_ROLES.has(role); }
const PARENT_WINDOW_MS = 60 * 60 * 1000;
const PARENT_CANDIDATE_CAP = 200;
const inferredParentCache = new Map();
const INFERRED_PARENT_CACHE_CAP = 5000;
export const SESSION_CAP = 2000;
export const ANALYTICS_SAMPLE_CAP = 20_000;
const GROUP_ROW_CAP = 20_000;
const LIVE_ROW_CAP = 20_000;
const LIVE_SESSION_CAP = 200;
const TOOL_ROW_CAP = 20_000;

export function inferParents(sessions) {
  const map = new Map();
  const byKey = new Map();
  const parsed = new Array(sessions.length);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const firstMs = s._firstMs ?? Date.parse(s.firstTs);
    const lastMs = s._lastMs ?? Date.parse(s.lastTs);
    const hasMain = (s.roles || []).some((r) => isMainRole(r.role));
    const item = { s, firstMs, lastMs, hasMain };
    parsed[i] = item;
    if (s._apiKey) {
      let arr = byKey.get(s._apiKey);
      if (!arr) {
        arr = [];
        byKey.set(s._apiKey, arr);
      }
      arr.push(item);
    }
  }

  for (const candidates of byKey.values()) {
    candidates.sort((a, b) => b.lastMs - a.lastMs);
  }

  for (let i = 0; i < parsed.length; i++) {
    const c = parsed[i];
    if (!c.s._apiKey) continue;
    const candidates = byKey.get(c.s._apiKey);
    if (!candidates || candidates.length <= 1) continue;

    let best = null;
    let bestStart = Infinity;
    const cFirst = c.firstMs;
    const cLast = c.lastMs;
    const cSess = c.s.session;
    const cClient = c.s.client;
    const cachedParent = inferredParentCache.get(cSess);
    if (cachedParent) {
      map.set(cSess, cachedParent);
      continue;
    }

    let checked = 0;
    for (const p of candidates) {
      if (p.lastMs < cFirst - PARENT_WINDOW_MS) break;
      if (p.s.session === cSess) continue;
      if (p.firstMs > cLast + PARENT_WINDOW_MS) continue;
      if (checked >= PARENT_CANDIDATE_CAP) break;
      checked++;
      const pFirst = p.firstMs;
      const pLast = p.lastMs;
      if (pFirst <= cFirst && pLast >= cLast) {
        const uaDiffers = p.s.client !== cClient;
        if (!uaDiffers && !p.hasMain) continue;
        if (pFirst === cFirst && pLast === cLast) continue;
        if (pFirst < bestStart || (pFirst === bestStart && best && String(p.s.session).localeCompare(String(best.session)) < 0)) {
          bestStart = pFirst;
          best = p.s;
        }
      }
    }
    if (best) {
      const assignment = { session: best.session, inferred: true, parentGuessed: true };
      if (inferredParentCache.size >= INFERRED_PARENT_CACHE_CAP) {
        inferredParentCache.delete(inferredParentCache.keys().next().value);
      }
      inferredParentCache.set(cSess, assignment);
      map.set(cSess, assignment);
    }
  }
  return map;
}

function normalizeSpan(row) {
  const client = clientOfUa(row.ua);
  const parsedRoles = parseJson(row.rolesJson, []);
  const roles = Array.isArray(parsedRoles)
    ? parsedRoles.filter((role) => typeof role === "string").map((role) => ({ role }))
    : [];
  return {
    session: String(row.sess),
    _apiKey: row.apiKey || null,
    _ua: row.ua || null,
    firstTs: row.firstTs,
    lastTs: row.lastTs,
    _firstMs: Date.parse(row.firstTs),
    _lastMs: Date.parse(row.lastTs),
    requests: Number(row.requests || 0),
    client,
    roles,
  };
}

function loadSessionSpans(db, fromIso, toIso, { apiKey = null, cap = SESSION_CAP } = {}) {
  const sExpr = sessionSql(hasSessionColumn(db));
  const roleCase = roleSql();
  const params = [fromIso, toIso];
  const keyFilter = apiKey ? "AND apiKey = ?" : "";
  if (apiKey) params.push(apiKey);
  const rows = db.all(
    `SELECT ${sExpr} AS sess,
            MIN(apiKey) AS apiKey,
            MIN(timestamp) AS firstTs,
            MAX(timestamp) AS lastTs,
            COUNT(*) AS requests,
            MIN(json_extract(meta,'$.ua')) AS ua,
            json_group_array(DISTINCT ${roleCase}) AS rolesJson
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ? AND ${sExpr} IS NOT NULL ${keyFilter}
     GROUP BY ${sExpr}
     ORDER BY lastTs DESC, sess DESC
     LIMIT ?`,
    [...params, cap + 1]
  );
  return {
    sessions: rows.slice(0, cap).map(normalizeSpan),
    truncated: rows.length > cap,
  };
}

function processSessionRows(roleRows, spans) {
  const sessionMap = new Map(spans.map((span) => [span.session, {
    session: span.session,
    _apiKey: span._apiKey,
    _ua: span._ua,
    firstTs: span.firstTs,
    lastTs: span.lastTs,
    _firstMs: span._firstMs,
    _lastMs: span._lastMs,
    requests: 0,
    tokens: 0,
    value: 0,
    errors: 0,
    _roleMap: new Map(),
  }]));
  for (const r of roleRows) {
    let s = sessionMap.get(r.sess);
    if (!s) continue;
    s.requests += r.requests;
    s.tokens += r.tokens || 0;
    s.value += num(r.value);
    s.errors += (r.errors != null ? r.errors : (r.requests - (r.oks || 0)));

    const combo = r.combo || "direct";
    let rEntry = s._roleMap.get(combo);
    if (!rEntry) {
      rEntry = { role: combo, models: new Map() };
      s._roleMap.set(combo, rEntry);
    }
    const modelKey = `${r.model || "unknown"}|${r.provider || ""}`;
    let mEntry = rEntry.models.get(modelKey);
    if (!mEntry) {
      mEntry = {
        model: r.model || "unknown",
        provider: r.provider || null,
        requests: 0,
        tokens: 0,
        value: 0,
        oks: 0,
        totalReqs: 0,
      };
      rEntry.models.set(modelKey, mEntry);
    }
    mEntry.requests += r.requests;
    mEntry.tokens += r.tokens || 0;
    mEntry.value += num(r.value);
    if (r.oks != null) mEntry.oks += r.oks;
    mEntry.totalReqs += r.requests;
  }

  const sessions = [];
  const modelByRoleMap = new Map();

  for (const s of sessionMap.values()) {
    const client = clientOfUa(s._ua);
    s.client = client;
    const roles = [];
    for (const [roleName, entry] of s._roleMap) {
      const finalRole = (roleName === "claude-haiku-5-5" && client === "Claude Code") ? "background" : roleName;
      let r = roles.find((x) => x.role === finalRole);
      if (!r) {
        r = { role: finalRole, models: [] };
        roles.push(r);
      }
      for (const mm of entry.models.values()) {
        r.models.push({
          model: mm.model,
          provider: mm.provider,
          requests: mm.requests,
          tokens: mm.tokens,
          value: mm.value,
        });

        const modelKey = `${finalRole}||${mm.model}`;
        let mg = modelByRoleMap.get(modelKey);
        if (!mg) {
          mg = {
            role: finalRole,
            model: mm.model,
            requests: 0,
            tokens: 0,
            value: 0,
            oks: 0,
            totalReqs: 0,
          };
          modelByRoleMap.set(modelKey, mg);
        }
        mg.requests += mm.requests;
        mg.tokens += mm.tokens;
        mg.value += mm.value;
        mg.oks += mm.oks;
        mg.totalReqs += mm.totalReqs;
      }
    }
    const merged = [];
    for (const r of roles) {
      const ex = merged.find((x) => x.role === r.role);
      if (ex) ex.models.push(...r.models);
      else merged.push(r);
    }
    s.roles = merged;
    delete s._roleMap;
    delete s._ua;
    sessions.push(s);
  }

  return { sessions, modelByRoleMap };
}

// ---------- listSessions ----------
export function listSessionsPage(db, fromIso, toIso, options = {}) {
  return runReadWorker(db, "listSessionsPage", [fromIso, toIso, options], () => listSessionsPageInline(db, fromIso, toIso, options));
}

async function listSessionsPageInline(db, fromIso, toIso, { limit = 100, cursor = null } = {}) {
  const has = hasSessionColumn(db);
  const sExpr = sessionSql(has);
  const statusExpr = statusSql();
  const pageLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 500));
  const spanResult = loadSessionSpans(db, fromIso, toIso);
  const parentMap = inferParents(spanResult.sessions);
  const cursorFoundIndex = typeof cursor === "string" && cursor
    ? spanResult.sessions.findIndex((span) => span.session === cursor)
    : -1;
  const cursorIndex = cursorFoundIndex >= 0 ? cursorFoundIndex + 1 : 0;
  if ((typeof cursor === "string" && cursor && cursorFoundIndex < 0) || cursorIndex >= spanResult.sessions.length) {
    return {
      sessions: [],
      total: spanResult.sessions.length,
      nextCursor: null,
      truncated: spanResult.truncated,
    };
  }
  const selected = spanResult.sessions.slice(cursorIndex, cursorIndex + pageLimit);
  if (!selected.length) {
    return { sessions: [], total: spanResult.sessions.length, nextCursor: null, truncated: spanResult.truncated };
  }

  const fetchedRoleRows = db.all(
    `SELECT ${sExpr} AS sess,
            COALESCE(NULLIF(json_extract(meta,'$.combo'),''), 'direct') AS combo,
            provider, COALESCE(model, 'unknown') AS model,
            COUNT(*) AS requests,
            COALESCE(SUM(promptTokens),0) AS promptTokens,
            COALESCE(SUM(completionTokens),0) AS completionTokens,
            COALESCE(SUM(COALESCE(promptTokens,0) + COALESCE(completionTokens,0)),0) AS tokens,
            COALESCE(SUM(cost),0) AS value,
            SUM(CASE WHEN ${statusExpr} <> 'ok' THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN ${statusExpr} = 'ok' THEN 1 ELSE 0 END) AS oks
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ? AND ${sExpr} IN (${selected.map(() => "?").join(",")})
     GROUP BY ${sExpr}, combo, provider, model
     LIMIT ?`,
    [fromIso, toIso, ...selected.map((span) => span.session), GROUP_ROW_CAP + 1]
  );
  const roleRowsTruncated = fetchedRoleRows.length > GROUP_ROW_CAP;
  const roleRows = fetchedRoleRows.slice(0, GROUP_ROW_CAP);

  const { sessions } = processSessionRows(roleRows, selected);
  const pageOrder = new Map(selected.map((span, index) => [span.session, index]));

  const results = sessions.map((s) => {
    const parent = parentMap.get(s.session) || null;
    const { _apiKey, _firstMs, _lastMs, ...rest } = s;
    return { ...rest, parent };
  }).sort((a, b) => pageOrder.get(a.session) - pageOrder.get(b.session));
  return {
    sessions: results,
    total: spanResult.sessions.length,
    nextCursor: cursorIndex + selected.length < spanResult.sessions.length
      ? results[results.length - 1]?.session || null
      : null,
    truncated: spanResult.truncated || roleRowsTruncated,
  };
}

export async function listSessions(db, fromIso, toIso) {
  const page = await listSessionsPage(db, fromIso, toIso, { limit: 500 });
  return page.sessions;
}

// ---------- getSessionDetail ----------
export function getSessionDetail(db, sessionId) {
  return runReadWorker(db, "getSessionDetail", [sessionId], () => getSessionDetailInline(db, sessionId));
}

async function getSessionDetailInline(db, sessionId) {
  const has = hasSessionColumn(db);
  const sExpr = sessionSql(has);
  const whereSql = sessionMatchSql(has);
  const params = has ? [sessionId, sessionId] : [sessionId];
  const fetchedRows = db.all(
    `SELECT id, timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, meta${has ? ", session" : ""}
     FROM usageHistory
     WHERE ${whereSql}
     ORDER BY timestamp DESC LIMIT 2001`,
    params
  );
  const requestTruncated = fetchedRows.length > 2000;
  const rows = fetchedRows.slice(0, 2000);
  const norm = rows.map((r) => normalizeRow(r, has)).reverse();

  // group by role (lane)
  const lanesMap = new Map();
  for (const r of norm) {
    if (!lanesMap.has(r.role)) lanesMap.set(r.role, { role: r.role, requests: [] });
    lanesMap.get(r.role).requests.push({
      ts: r.ts,
      model: r.model,
      provider: r.provider,
      combo: r.combo,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      value: r.value,
      ttftMs: r.ttftMs,
      totalMs: r.totalMs,
      status: r.status,
    });
  }
  const agents = [...lanesMap.values()];

  let children = [];
  let childrenTruncated = false;
  try {
    const apiKey = norm.find((row) => row.apiKey)?.apiKey || null;
    if (apiKey) {
      const spanParams = has ? [sessionId, sessionId, apiKey] : [sessionId, apiKey];
      const spanWhere = has
        ? "((session = ? OR (session IS NULL AND json_extract(meta,'$.session') = ?)) AND apiKey = ?)"
        : "(json_extract(meta,'$.session') = ? AND apiKey = ?)";
      const roleCase = roleSql();
      const span = db.get(
        `SELECT ${sExpr} AS sess, MIN(apiKey) AS apiKey,
                MIN(timestamp) AS firstTs, MAX(timestamp) AS lastTs,
                MIN(json_extract(meta,'$.ua')) AS ua,
                json_group_array(DISTINCT ${roleCase}) AS rolesJson
         FROM usageHistory WHERE ${spanWhere}
         GROUP BY ${sExpr} LIMIT 1`,
        spanParams
      );
      if (span?.firstTs && span?.lastTs) {
        const fromMs = Date.parse(span.firstTs) - PARENT_WINDOW_MS;
        const toMs = Date.parse(span.lastTs) + PARENT_WINDOW_MS;
        const spanResult = loadSessionSpans(
          db,
          new Date(fromMs).toISOString(),
          new Date(toMs + 1).toISOString(),
          { apiKey, cap: SESSION_CAP }
        );
        const candidates = spanResult.sessions;
        const target = candidates.find((s) => s.session === sessionId);
        let targetWasCapped = false;
        if (target) {
          target.firstTs = span.firstTs;
          target.lastTs = span.lastTs;
          target._firstMs = Date.parse(span.firstTs);
          target._lastMs = Date.parse(span.lastTs);
        } else {
          if (candidates.length >= SESSION_CAP) {
            candidates.pop();
            targetWasCapped = true;
          }
          candidates.push(normalizeSpan(span));
        }
        childrenTruncated = spanResult.truncated || targetWasCapped;
        const parentMap = inferParents(candidates);
        children = [...parentMap.entries()]
          .filter(([, v]) => v.session === sessionId)
          .map(([k, parent]) => ({ session: k, inferred: true, parentGuessed: parent.parentGuessed === true }));
      }
    }
  } catch (e) { children = []; }

  const client = norm.length ? norm[0].client : "Unknown";
  const firstTs = norm.length ? norm[0].ts : null;
  const lastTs = norm.length ? norm[norm.length - 1].ts : null;
  return { session: sessionId, client, firstTs, lastTs, agents, children, truncated: requestTruncated || childrenTruncated };
}

// ---------- analytics ----------
export function getAnalytics(db, fromIso, toIso) {
  return runReadWorker(db, "getAnalytics", [fromIso, toIso], () => getAnalyticsInline(db, fromIso, toIso));
}

async function getAnalyticsInline(db, fromIso, toIso) {
  const sExpr = sessionSql(hasSessionColumn(db));
  const statusExpr = statusSql();
  const roleCase = roleSql();

  // Aggregate full-range counts and sums in SQLite. The JS layer only handles
  // one row per role/model/session-presence group.
  const fetchedMetricRows = db.all(
    `SELECT ${roleCase} AS role,
            COALESCE(model, 'unknown') AS model,
            CASE WHEN ${sExpr} IS NULL THEN 0 ELSE 1 END AS hasSession,
            COUNT(*) AS requests,
            COALESCE(SUM(COALESCE(promptTokens,0) + COALESCE(completionTokens,0)),0) AS tokens,
            COALESCE(SUM(cost),0) AS value,
            SUM(CASE WHEN ${statusExpr} = 'ok' THEN 1 ELSE 0 END) AS oks
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ?
     GROUP BY role, model, hasSession
     LIMIT ?`,
    [fromIso, toIso, GROUP_ROW_CAP + 1]
  );
  const metricRowsTruncated = fetchedMetricRows.length > GROUP_ROW_CAP;
  const metricRows = fetchedMetricRows.slice(0, GROUP_ROW_CAP);

  const modelByRoleMap = new Map();
  const byRoleMap = new Map();
  let totalSessionRequests = 0;
  for (const row of metricRows) {
    const role = row.role || "direct";
    const model = row.model || "unknown";
    const modelKey = `${role}||${model}`;
    let modelEntry = modelByRoleMap.get(modelKey);
    if (!modelEntry) {
      modelEntry = { role, model, requests: 0, tokens: 0, value: 0, oks: 0, totalReqs: 0 };
      modelByRoleMap.set(modelKey, modelEntry);
    }
    modelEntry.requests += Number(row.requests || 0);
    modelEntry.tokens += Number(row.tokens || 0);
    modelEntry.value += num(row.value);
    modelEntry.oks += Number(row.oks || 0);
    modelEntry.totalReqs += Number(row.requests || 0);

    if (Number(row.hasSession)) {
      let roleEntry = byRoleMap.get(role);
      if (!roleEntry) {
        roleEntry = { role, sessions: 0, requests: 0, tokens: 0, value: 0 };
        byRoleMap.set(role, roleEntry);
      }
      roleEntry.requests += Number(row.requests || 0);
      roleEntry.tokens += Number(row.tokens || 0);
      roleEntry.value += num(row.value);
      totalSessionRequests += Number(row.requests || 0);
    }
  }

  const spanResult = loadSessionSpans(db, fromIso, toIso);
  let delegatedSessions = 0;
  const roleSessionCounts = new Map();
  for (const session of spanResult.sessions) {
    const roles = new Set((session.roles || []).map(({ role }) => bgRole(session.client, role)));
    for (const role of roles) roleSessionCounts.set(role, (roleSessionCounts.get(role) || 0) + 1);
    if ([...roles].some((role) => !isMainRole(role))) delegatedSessions++;
  }
  for (const [role, entry] of byRoleMap) entry.sessions = roleSessionCounts.get(role) || 0;

  const totalRequests = metricRows.reduce((sum, row) => sum + Number(row.requests || 0), 0);
  const totalReqs = totalRequests || 1;
  for (const row of metricRows) {
    const role = row.role || "direct";
    let roleEntry = byRoleMap.get(role);
    if (!roleEntry) {
      roleEntry = { role, sessions: 0, requests: 0, tokens: 0, value: 0 };
      byRoleMap.set(role, roleEntry);
    }
    // Session-backed rows were added above. Add only rows without a session here.
    if (!Number(row.hasSession)) {
      roleEntry.requests += Number(row.requests || 0);
      roleEntry.tokens += Number(row.tokens || 0);
      roleEntry.value += num(row.value);
    }
  }
  const allByRole = [...byRoleMap.values()].map((r) => ({ ...r, value: num(r.value), share: r.requests / totalReqs }))
    .sort((a, b) => b.requests - a.requests);

  const delegationRate = spanResult.sessions.length ? delegatedSessions / spanResult.sessions.length : 0;

  const parentMap = inferParents(spanResult.sessions);
  const childCount = parentMap.size;
  const childrenPerSession = spanResult.sessions.length ? childCount / spanResult.sessions.length : 0;

  // The global LIMIT uses idx_uh_ts and bounds both SQLite's result set and JS
  // percentile work. Percentiles describe the newest sample across the range.
  const latencyRows = db.all(
    `SELECT ${roleCase} AS role,
            COALESCE(model, 'unknown') AS model,
            json_extract(meta, '$.latency.totalMs') AS totalMs,
            json_extract(meta, '$.latency.ttftMs') AS ttftMs,
            json_extract(meta, '$.latency.stream') AS stream,
            COALESCE(completionTokens, 0) AS completionTokens
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ?
       AND json_extract(meta, '$.latency') IS NOT NULL
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`,
    [fromIso, toIso, ANALYTICS_SAMPLE_CAP]
  );

  const latencyGroups = new Map();
  for (const r of latencyRows) {
    const key = `${r.role}||${r.model}`;
    let g = latencyGroups.get(key);
    if (!g) {
      g = { totals: [], ttfts: [], tps: [] };
      latencyGroups.set(key, g);
    }
    const tot = r.totalMs != null ? Number(r.totalMs) : null;
    const ttft = r.ttftMs != null ? Number(r.ttftMs) : null;
    if (tot != null && Number.isFinite(tot)) g.totals.push(tot);
    if (ttft != null && Number.isFinite(ttft)) g.ttfts.push(ttft);
    const isStream = Boolean(r.stream);
    if (isStream && ttft != null && tot != null && tot > ttft && r.completionTokens > 0) {
      const tps = r.completionTokens / ((tot - ttft) / 1000);
      if (Number.isFinite(tps)) g.tps.push(tps);
    }
  }

  const modelByRole = [...modelByRoleMap.values()].map((g) => {
    const key = `${g.role}||${g.model}`;
    const lat = latencyGroups.get(key);
    return {
      role: g.role,
      model: g.model,
      requests: g.requests,
      tokens: g.tokens,
      value: num(g.value),
      tpsP50: lat ? percentile(lat.tps, 50) : null,
      ttftP50: lat ? percentile(lat.ttfts, 50) : null,
      totalP50: lat ? percentile(lat.totals, 50) : null,
      totalP95: lat ? percentile(lat.totals, 95) : null,
      successRate: g.totalReqs ? g.oks / g.totalReqs : 1,
      samples: lat ? lat.totals.length : 0,
    };
  }).sort((a, b) => b.requests - a.requests);

  return {
    byRole: allByRole,
    totalRequests,
    sessionRequests: totalSessionRequests,
    delegationRate,
    childrenPerSession,
    modelByRole,
    sampled: { rows: latencyRows.length, cap: ANALYTICS_SAMPLE_CAP },
    truncated: spanResult.truncated || metricRowsTruncated,
  };
}

// ---------- live ----------
export function getLive(db, nowMs = Date.now()) {
  return Promise.resolve(runReadWorker(db, "getLive", [nowMs], () => getLiveInline(db, nowMs)))
    .then((result) => mergeLiveSnapshot(result, liveSnapshot(), nowMs));
}

function mergeLiveSnapshot(result, activeBySession, nowMs) {
  try {
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    const byId = new Map(sessions.map((session) => [session.session, session]));
    const nowIso = new Date(nowMs).toISOString();
    for (const [sessionId, requests] of Object.entries(activeBySession || {})) {
      if (!Array.isArray(requests) || !requests.length) continue;
      let session = byId.get(sessionId);
      if (!session) {
        session = {
          session: sessionId,
          client: "Unknown",
          lastTs: nowIso,
          reqPerMin: 0,
          tpsRecent: null,
          p50TotalMs: null,
          successRate: 1,
          roles: [],
          inFlight: 0,
          pulsing: true,
        };
        sessions.push(session);
        byId.set(sessionId, session);
      }
      const roles = new Map((session.roles || []).map((role) => [role.role, role]));
      const currentByRole = new Map();
      for (const request of requests) {
        const roleName = roleOf({ combo: request.combo });
        const current = currentByRole.get(roleName);
        if (!current || (request.startedAt || 0) >= (current.startedAt || 0)) currentByRole.set(roleName, request);
      }
      for (const [roleName, current] of currentByRole) {
        const role = roles.get(roleName) || { role: roleName, model: current.model || "unknown", requests: 0 };
        const roleRequests = requests.filter((request) => roleOf({ combo: request.combo }) === roleName);
        role.inFlight = roleRequests.length;
        role.model = current.model || role.model || "unknown";
        role.state = roleRequests.some((request) => request.firstTokenAt != null) ? "streaming" : "thinking";
        role.lastActivityMs = nowMs;
        role.idleSeconds = 0;
        role.tps ??= null;
        role.p50Ms ??= null;
        role.pulsing = true;
        roles.set(roleName, role);
      }
      const count = requests.length;
      session.roles = [...roles.values()];
      session.inFlight = (session.inFlight || 0) + count;
      session.lastActivityMs = nowMs;
      session.pulsing = true;
      session.reqPerMin = ((session.reqPerMin || 0) * 5 + count) / 5;
      if (!session.lastTs || session.lastTs < nowIso) session.lastTs = nowIso;
    }
    sessions.sort((a, b) => String(b.lastTs || "").localeCompare(String(a.lastTs || "")));
    const inFlight = Object.values(activeBySession || {}).reduce((sum, requests) => sum + (Array.isArray(requests) ? requests.length : 0), 0);
    for (const session of sessions) {
      const lastActivityMs = session.lastActivityMs || (session.lastTs ? Date.parse(session.lastTs) : null);
      session.lastActivityMs = Number.isFinite(lastActivityMs) ? lastActivityMs : null;
      session.inFlight ||= 0;
      for (const role of session.roles || []) {
        role.inFlight ||= 0;
        role.state ||= role.inFlight ? "thinking" : "idle";
        role.lastActivityMs ||= session.lastActivityMs;
        role.idleSeconds = role.inFlight ? 0 : (role.lastActivityMs ? Math.max(0, Math.floor((nowMs - role.lastActivityMs) / 1000)) : null);
        role.tps ??= null;
        role.p50Ms ??= null;
      }
    }
    return { ...(result || {}), inFlight, sessions: sessions.slice(0, LIVE_SESSION_CAP) };
  } catch {
    return result || { sessions: [], sampled: { rows: 0, cap: LIVE_ROW_CAP } };
  }
}

function getToolsInline(db, fromIso, toIso) {
  const roleCase = roleSql();
  const rows = db.all(
    `SELECT id, model, ${roleCase} AS role, meta
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ?
       AND json_valid(meta)
       AND (json_type(meta, '$.tools') = 'array' OR json_type(meta, '$.toolErrors') = 'array')
     ORDER BY id DESC LIMIT ?`,
    [fromIso, toIso, TOOL_ROW_CAP]
  );
  const tools = new Map();
  const roleTotals = new Map();
  for (const row of rows) {
    const meta = parseMeta(row.meta) || {};
    const rowTools = Array.isArray(meta.tools) ? meta.tools.slice(0, 50) : [];
    const rowErrors = Array.isArray(meta.toolErrors) ? meta.toolErrors.slice(0, 50) : [];
    const callsByName = new Map();
    for (const entry of rowTools) {
      if (!entry || typeof entry.name !== "string") continue;
      const name = /^[A-Za-z0-9_.:-]{1,64}$/.test(entry.name) ? entry.name : "unknown";
      callsByName.set(name, Math.min(50, Math.max(0, Number(entry.count) || 0)));
    }
    const errorsByName = new Map();
    for (const entry of rowErrors) {
      if (!entry || typeof entry.name !== "string") continue;
      const name = /^[A-Za-z0-9_.:-]{1,64}$/.test(entry.name) ? entry.name : "unknown";
      errorsByName.set(name, Math.min(50, Math.max(0, Number(entry.count) || 0)));
    }
    for (const name of new Set([...callsByName.keys(), ...errorsByName.keys()])) {
      const calls = callsByName.get(name) || 0;
      const errors = errorsByName.get(name) || 0;
      let tool = tools.get(name);
      if (!tool) { tool = { name, calls: 0, errors: 0, byRole: new Map(), byModel: new Map() }; tools.set(name, tool); }
      tool.calls += calls;
      tool.errors += errors;
      const role = row.role || "direct";
      const model = row.model || "unknown";
      const roleKey = role === "direct" ? `${role}\u0000${model}` : role;
      const roleCount = tool.byRole.get(roleKey) || { role, ...(role === "direct" ? { model } : {}), calls: 0, errors: 0 };
      roleCount.calls += calls;
      roleCount.errors += errors;
      tool.byRole.set(roleKey, roleCount);
      if (calls) tool.byModel.set(model, (tool.byModel.get(model) || 0) + calls);
      const key = `${role}\u0000${name}`;
      const top = roleTotals.get(key) || { role, name, calls: 0, errors: 0 };
      top.calls += calls;
      top.errors += errors;
      roleTotals.set(key, top);
    }
  }
  const result = [...tools.values()].map((tool) => {
    const topModel = [...tool.byModel].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      name: tool.name,
      calls: tool.calls,
      errors: tool.errors,
      errorPct: tool.calls ? Math.min(100, tool.errors / tool.calls * 100) : 0,
      byRole: [...tool.byRole.values()].sort((a, b) => b.calls - a.calls),
      topModel: topModel ? { model: topModel[0], calls: topModel[1] } : null,
    };
  }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const byRole = new Map();
  for (const entry of roleTotals.values()) {
    if (!byRole.has(entry.role)) byRole.set(entry.role, []);
    byRole.get(entry.role).push({ name: entry.name, calls: entry.calls, errors: entry.errors });
  }
  const topToolsByRole = [...byRole].map(([role, list]) => ({
    role,
    tools: list.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, 10),
  }));
  return { tools: result, topToolsByRole, sampled: { rows: rows.length, cap: TOOL_ROW_CAP }, truncated: rows.length >= TOOL_ROW_CAP };
}

export function getTools(db, fromIso, toIso) {
  return runReadWorker(db, "getTools", [fromIso, toIso], () => getToolsInline(db, fromIso, toIso));
}

async function getLiveInline(db, nowMs = Date.now()) {
  const has = hasSessionColumn(db);
  const sExpr = sessionSql(has);
  const statusExpr = statusSql();
  const roleCase = roleSql();
  const fiveMinAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
  const recentCte = `WITH recent AS (
       SELECT id, timestamp, ${sExpr} AS sess, model, completionTokens, status, meta
       FROM usageHistory
       WHERE timestamp >= ? AND ${sExpr} IS NOT NULL
       ORDER BY timestamp DESC, id DESC
       LIMIT ?
     )`;
  const summaryRows = db.all(
    `${recentCte}
     SELECT sess, MAX(timestamp) AS lastTs,
            MIN(json_extract(meta, '$.ua')) AS ua,
            COUNT(*) AS requests,
            SUM(CASE WHEN ${statusExpr} = 'ok' THEN 1 ELSE 0 END) AS oks
     FROM recent
     GROUP BY sess
     ORDER BY lastTs DESC, sess DESC
     LIMIT ?`,
    [fiveMinAgo, LIVE_ROW_CAP, LIVE_SESSION_CAP + 1]
  );
  if (!summaryRows.length) return { sessions: [], sampled: { rows: 0, cap: LIVE_ROW_CAP } };

  const sessionTruncated = summaryRows.length > LIVE_SESSION_CAP;
  const selectedSummaryRows = summaryRows.slice(0, LIVE_SESSION_CAP);
  const sessionIds = selectedSummaryRows.map((row) => row.sess);
  const placeholders = sessionIds.map(() => "?").join(",");
  const roleRows = db.all(
    `${recentCte}
     SELECT sess, ${roleCase} AS role, COALESCE(model, 'unknown') AS model,
            COUNT(*) AS requests, MAX(timestamp) AS lastTs
     FROM recent
     WHERE sess IN (${placeholders})
     GROUP BY sess, role, model`,
    [fiveMinAgo, LIVE_ROW_CAP, ...sessionIds]
  );
  const latencyRows = db.all(
    `${recentCte}
     SELECT sess, ${roleCase} AS role,
            json_extract(meta, '$.latency.totalMs') AS totalMs,
            json_extract(meta, '$.latency.ttftMs') AS ttftMs,
            json_extract(meta, '$.latency.stream') AS stream,
            COALESCE(completionTokens, 0) AS completionTokens
     FROM recent
     WHERE sess IN (${placeholders}) AND json_extract(meta, '$.latency') IS NOT NULL
     LIMIT ?`,
    [fiveMinAgo, LIVE_ROW_CAP, ...sessionIds, LIVE_ROW_CAP]
  );

  const rolesBySession = new Map();
  for (const row of roleRows) {
    let roles = rolesBySession.get(row.sess);
    if (!roles) { roles = new Map(); rolesBySession.set(row.sess, roles); }
    let role = roles.get(row.role);
    if (!role) {
      role = { role: row.role, model: row.model, requests: 0, _lastTs: row.lastTs };
      roles.set(row.role, role);
    }
    role.requests += Number(row.requests || 0);
    if (row.lastTs > role._lastTs) {
      role.model = row.model;
      role._lastTs = row.lastTs;
    }
  }
  const latencyBySession = new Map();
  const latencyBySessionRole = new Map();
  for (const row of latencyRows) {
    let samples = latencyBySession.get(row.sess);
    if (!samples) { samples = { totals: [], tps: [] }; latencyBySession.set(row.sess, samples); }
    const roleKey = `${row.sess}\u0000${row.role || "direct"}`;
    let roleSamples = latencyBySessionRole.get(roleKey);
    if (!roleSamples) { roleSamples = { totals: [], tps: [] }; latencyBySessionRole.set(roleKey, roleSamples); }
    const totalMs = row.totalMs != null ? Number(row.totalMs) : null;
    const ttftMs = row.ttftMs != null ? Number(row.ttftMs) : null;
    if (totalMs != null && Number.isFinite(totalMs)) {
      samples.totals.push(totalMs);
      roleSamples.totals.push(totalMs);
    }
    if (Boolean(row.stream) && ttftMs != null && totalMs != null && totalMs > ttftMs && row.completionTokens > 0) {
      const tps = row.completionTokens / ((totalMs - ttftMs) / 1000);
      if (Number.isFinite(tps)) {
        samples.tps.push(tps);
        roleSamples.tps.push(tps);
      }
    }
  }

  const sampledRows = summaryRows.reduce((sum, row) => sum + Number(row.requests || 0), 0);
  const sessions = selectedSummaryRows.map((row) => {
    const samples = latencyBySession.get(row.sess) || { totals: [], tps: [] };
    const roles = [...(rolesBySession.get(row.sess)?.values() || [])]
      .map(({ _lastTs, ...role }) => {
        const roleSamples = latencyBySessionRole.get(`${row.sess}\u0000${role.role}`) || { totals: [], tps: [] };
        return { ...role, tps: percentile(roleSamples.tps, 50), p50Ms: percentile(roleSamples.totals, 50) };
      });
    return {
      session: row.sess,
      client: clientOfUa(row.ua),
      lastTs: row.lastTs,
      reqPerMin: Number(row.requests || 0) / 5,
      tpsRecent: percentile(samples.tps, 50),
      p50TotalMs: percentile(samples.totals, 50),
      successRate: row.requests ? Number(row.oks || 0) / Number(row.requests) : 1,
      roles,
    };
  });
  return {
    sessions,
    sampled: { rows: sampledRows, cap: LIVE_ROW_CAP },
    truncated: sampledRows >= LIVE_ROW_CAP || sessionTruncated,
  };
}
