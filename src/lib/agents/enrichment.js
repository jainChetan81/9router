/**
 * Session enrichment from T3 Code state (N9/B4).
 *
 * Reads `~/.t3/userdata/statev2.sqlite` read-only and maps an agent session
 * hash (sha256 of the raw session id, first 12 hex) to its T3 thread.
 *
 * Allowed fields ONLY, per FUTURE.md item 4: thread title, project name,
 * working directory / worktree, real parent session link, friendly device
 * name, client version, start/last timestamps, totals, roles/models, and tool
 * call summaries. Prompts, results, secrets, raw payload_json, raw native ids,
 * raw IP and raw ua values are never read or returned.
 *
 * Every lookup fails open to null: a session that does not match a T3 thread
 * (spend hygiene bots, OpenCode ad-hoc runs) enriches nothing.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";

const T3_DB = () => (process.env?.T3_STATE_DB
  ? process.env.T3_STATE_DB
  : `${process.env.HOME || "/root"}/.t3/userdata/statev2.sqlite`);

const CACHE_TTL_MS = 60_000;

let cache = null; // { builtAt, byHash: Map(hash -> {threadId}), threadNative: Map(threadId -> hash), threadParent: Map(threadId -> parentThreadId) }

function sha(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

function hashForProvider(provider, nativeId) {
  if (nativeId == null || nativeId === "") return null;
  const id = String(nativeId);
  // T3 stores Claude Code provider threads as "claudeAgent"; their native id
  // enters the session hash as "claude:<uuid>" (verified against usage rows).
  if (provider === "claude" || provider === "claudeAgent") return sha(`claude:${id}`);
  if (provider === "antigravity") return sha(`antigravity:${id}`);
  return sha(id);
}

function isHex12(value) { return typeof value === "string" && /^[0-9a-f]{12}$/.test(value); }

function buildIndex() {
  const db = new DatabaseSync(T3_DB(), { readOnly: true });
  const byHash = new Map();
  const threadNative = new Map();
  const threadParent = new Map(); // child thread id -> real parent thread id

  // Provider thread rows: threadId -> session hash of one native id. Some
  // payload paths replaced deprecated ones; both are read from the same row.
  const pts = db.prepare(
    `SELECT thread_id, provider, payload_json
     FROM orchestration_v2_projection_provider_threads
     WHERE payload_json IS NOT NULL`
  ).all();
  for (const row of pts) {
    let payload = null;
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (!payload || typeof payload !== "object") continue;
    const nativeId = payload?.nativeThreadRef?.nativeId
      ?? payload?.nativeConversationHeadRef?.nativeId
      ?? payload?.appThreadId
      ?? null;
    const hash = hashForProvider(row.provider, nativeId);
    if (!isHex12(hash)) continue;
    if (!threadNative.has(row.thread_id)) threadNative.set(row.thread_id, hash);
    if (!byHash.has(hash)) byHash.set(hash, row.thread_id);
  }

  // Legacy binding rows
  try {
    const legacy = db.prepare(
      `SELECT thread_id, provider_session_id FROM projection_thread_sessions`
    ).all();
    for (const row of legacy) {
      const hash = row.provider_session_id ? sha(row.provider_session_id) : null;
      if (!isHex12(hash) || byHash.has(hash)) continue;
      byHash.set(hash, row.thread_id);
      if (!threadNative.has(row.thread_id)) threadNative.set(row.thread_id, hash);
    }
  } catch { /* legacy table optional */ }

  // Real parents: threads payload lineage.parentThreadId; never read for
  // anything else. Subagent rows add child -> parent edges; their payload
  // (prompts/results) is never touched.
  try {
    const threads = db.prepare(
      `SELECT thread_id, json_extract(payload_json, '$.lineage.parentThreadId') AS parentThreadId
       FROM orchestration_v2_projection_threads`
    ).all();
    for (const row of threads) {
      if (row.parentThreadId) threadParent.set(row.thread_id, row.parentThreadId);
    }
  } catch { /* payload lineage optional */ }

  try {
    const subagents = db.prepare(
      `SELECT thread_id, child_thread_id FROM orchestration_v2_projection_subagents`
    ).all();
    for (const row of subagents) {
      if (row.child_thread_id && row.thread_id) {
        if (!threadParent.has(row.child_thread_id)) threadParent.set(row.child_thread_id, row.thread_id);
      }
    }
  } catch { /* subagent table optional */ }

  try { db.close(); } catch { /* already closed */ }
  return { byHash, threadNative, threadParent };
}

function t3Index() {
  const now = Date.now();
  if (cache && now - cache.builtAt < CACHE_TTL_MS) return cache;
  cache = { builtAt: now, ...buildIndex() };
  return cache;
}

// ---- device name ----

let tsDeviceCache = { at: 0, name: null };
let tsProbeInFlight = null;
const TAILSCALE_TTL_MS = 5 * 60_000;

function readTailscale(timeoutMs = 3000) {
  if (tsDeviceCache.name && Date.now() - tsDeviceCache.at < TAILSCALE_TTL_MS) {
    return Promise.resolve(tsDeviceCache.name);
  }
  if (tsProbeInFlight) return tsProbeInFlight;
  tsProbeInFlight = new Promise((resolve) => {
    let settled = false;
    const done = (name) => {
      if (settled) return;
      settled = true;
      tsDeviceCache = { at: Date.now(), name };
      tsProbeInFlight = null;
      resolve(name);
    };
    try {
      const child = spawn("tailscale", ["status", "--json"], { timeout: timeoutMs });
      let raw = "";
      child.stdout.on("data", (chunk) => { raw += chunk; });
      child.on("error", () => done(null));
      child.on("close", () => {
        try {
          const json = JSON.parse(raw);
          const self = json?.Self?.HostName || json?.Self?.DNSName?.replace(/\.$/, "") || null;
          done(self || null);
        } catch { done(null); }
      });
    } catch { done(null); }
  });
  return tsProbeInFlight;
}

export async function deviceName() {
  const ts = await readTailscale();
  if (ts) return ts;
  return os.hostname() || "local";
}

function threadFacts(threadId, index) {
  // title, project, worktree directory for one thread. Only these columns.
  try {
    const db = new DatabaseSync(T3_DB(), { readOnly: true });
    const facts = { title: null, project: null, directory: null };
    const row = db.prepare(
      `SELECT t.title AS title, p.title AS project,
              json_extract(t.payload_json, '$.worktreePath') AS worktreePath
       FROM orchestration_v2_projection_threads t
       LEFT JOIN projection_projects p ON p.project_id = t.project_id
       WHERE t.thread_id = ? LIMIT 1`
    ).get(threadId);
    if (row) {
      facts.title = typeof row.title === "string" && row.title ? row.title : null;
      facts.project = typeof row.project === "string" && row.project ? row.project : null;
      facts.directory = typeof row.worktreePath === "string" && row.worktreePath ? row.worktreePath : null;
    }
    if (!facts.directory) {
      // Fall back to the cwd recorded on a provider session bound to the thread.
      try {
        const cwdRow = db.prepare(
          `SELECT json_extract(ps.payload_json, '$.cwd') AS cwd
           FROM orchestration_v2_projection_provider_sessions ps
           WHERE ps.thread_id = ? AND ps.payload_json IS NOT NULL
           ORDER BY ps.provider_session_id LIMIT 1`
        ).get(threadId);
        if (typeof cwdRow?.cwd === "string" && cwdRow.cwd) facts.directory = cwdRow.cwd;
      } catch { /* provider sessions optional */ }
    }
    try { db.close(); } catch { /* already closed */ }
    return facts;
  } catch { return { title: null, project: null, directory: null }; }
}

function parentHashOf(threadId, index) {
  const parentThreadId = index.threadParent.get(threadId);
  if (!parentThreadId) return null;
  return index.threadNative.get(parentThreadId) || null;
}

/**
 * Enrichment for one session hash. Returns allowed fields only, or null.
 * `parent` is a real T3 link (`inferred:false, parentGuessed:false`) or null;
 * guessed links are produced by `inferParents()` in queries.js, never here.
 */
export async function enrichSession(sessionHash) {
  if (!isHex12(sessionHash)) return null;
  let index;
  try { index = t3Index(); } catch { return null; } // T3 DB unreadable -> no enrichment
  const threadId = index.byHash.get(sessionHash);
  if (!threadId) return null;
  const facts = threadFacts(threadId, index);
  const parent = parentHashOf(threadId, index);
  const dev = await deviceName().catch(() => null);
  return {
    title: facts.title,
    project: facts.project,
    directory: facts.directory,
    device: dev,
    parent: parent ? { session: parent, inferred: false, parentGuessed: false } : null,
  };
}

/** Reset cached state (tests). */
export function resetEnrichmentCache() {
  cache = null;
  tsDeviceCache = { at: 0, name: null };
  tsProbeInFlight = null;
}
