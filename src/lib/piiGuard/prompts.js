// Masked prompt store: the new messages of each request, linked to its request and session, searchable.
// Detected values are masked (library maskText) and the result is rescanned; a record that still shows a finding
// is dropped. Undetected text (names, custom secrets) stays readable: this is a partially masked store.
// Lives in ~/.cache, which vps-backup skips; the directory is 0700 and the files 0600.
//
// Nothing here touches SQLite on the request path. `capture` masks and queues; the queue is written in one
// transaction about once a second by a writer thread (promptWorker.mjs), which also answers the dashboard's
// reads and runs retention. Without worker threads the same batches are written from a timer on this thread.
// A record still queued when the process stops is lost: at most about a second of prompts.
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import * as store from "./promptDb.mjs";

export const PROMPT_CAP = 1024 * 1024, TOOL_CAP = 128 * 1024, REQUEST_CAP = 4 * 1024 * 1024;
// Queue bound is bytes; the message count only stops pathological bodies of tiny strings.
const QUEUE_MAX = 5000, QUEUE_BYTES = 64 * 1024 * 1024, SEEN_MAX = 200_000, SEEN_SESSIONS = 10_000;
// A batch goes out after FLUSH_MS, or at once when it is this large.
const FLUSH_MS = 1000, FLUSH_ROWS = 256, FLUSH_BYTES = 4 * 1024 * 1024;
const INLINE_SLICE = 16, PARK_MAX = 500, CAPTURED_MAX = 5000, RPC_TIMEOUT_MS = 30_000, WORKER_FAILURES_MAX = 3, HOUR = 36e5;

// One store per process, even when the bundler loads this module more than once.
function fresh() {
  return {
    stats: { stored: 0, dropped: 0, unsafe: 0, errors: 0 },
    queue: [], rows: 0, queuedBytes: 0, inflightBytes: 0, timer: null, soon: false,
    // Per-session message digests already stored, so a resent conversation stores only what is new.
    // Bounded (least recently used session goes first); a session missing here is seeded from the store.
    seen: new Map(), pending: new Map(),
    // Requests of a session whose digests are not loaded yet wait here; nothing is read on the request path.
    parked: new Map(), parkedJobs: 0, parkedBytes: 0, seedWait: new Map(),
    captured: new Map(),
    worker: null, rpcs: new Map(), nextId: 1, workerFailures: 0,
    inline: null, inlineFile: null, inlineFailed: false, sweepTimer: null, lastSweep: 0,
  };
}
const S = (globalThis.__nineRouterPiiPromptStore ||= fresh());
export const stats = S.stats;

// Next to a custom events file (tests, other installs); otherwise in ~/.cache, outside backups.
export function promptsFile() {
  const p = process.env.PII_GUARD_PROMPTS;
  if (p && p !== "off") return p;
  // A test run must never write to the real store in the home directory.
  if (process.env.VITEST) return join(tmpdir(), `pii-guard-test-${process.pid}`, "prompts.db");
  return process.env.PII_GUARD_EVENTS ? join(dirname(process.env.PII_GUARD_EVENTS), "prompts.db") : join(homedir(), ".cache/pii-guard/prompts.db");
}

// PII_GUARD_PROMPTS_WORKER=off keeps the store on this thread; tests default to that, so they stay synchronous.
function workerMode() {
  if (S.workerFailures >= WORKER_FAILURES_MAX) return false;
  const v = process.env.PII_GUARD_PROMPTS_WORKER;
  if (v === "off" || v === "0") return false;
  if (v === "on" || v === "1") return true;
  return !process.env.VITEST;
}

function settle(id, error, result) {
  const call = S.rpcs.get(id);
  if (!call) return;
  S.rpcs.delete(id);
  clearTimeout(call.timer);
  if (error) call.reject(error); else call.resolve(result);
}
function worker() {
  if (S.worker) return S.worker;
  const w = new Worker(new URL("./promptWorker.mjs", import.meta.url));
  w.unref();
  const gone = (error) => {
    if (S.worker !== w) return;
    S.worker = null; S.workerFailures++;
    for (const id of [...S.rpcs.keys()]) settle(id, error);
  };
  w.on("message", (m) => { S.workerFailures = 0; settle(m?.id, m?.error ? new Error(m.error) : null, m?.result); });
  w.on("error", (error) => gone(error));
  w.on("exit", () => gone(new Error("prompt store worker exited")));
  return (S.worker = w);
}
function rpc(method, args, file = promptsFile()) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = worker(); } catch (error) { S.workerFailures++; return reject(error); }
    const id = S.nextId++;
    const timer = setTimeout(() => settle(id, new Error("prompt store worker timed out")), RPC_TIMEOUT_MS);
    timer.unref?.();
    S.rpcs.set(id, { resolve, reject, timer });
    w.postMessage({ id, method, file, args });
  });
}

// Main-thread connection: the fallback writer, and the synchronous reads below.
function inline(file = promptsFile()) {
  if (S.inline && S.inlineFile !== file) { store.closeDb(S.inline); S.inline = null; S.inlineFailed = false; }
  if (S.inline || S.inlineFailed) return S.inline;
  S.inlineFile = file;
  S.inline = store.openDb(file);
  if (!S.inline) { S.inlineFailed = true; return null; }
  // Retention runs on a timer too, so it never depends on traffic. The writer thread has its own.
  if (!workerMode()) {
    if (!S.sweepTimer) { S.sweepTimer = setInterval(sweepSlice, HOUR); S.sweepTimer.unref(); }
    setTimeout(sweepSlice, 0).unref();
  }
  return S.inline;
}
// Fallback retention: short slices, so this thread is never held for long.
function sweepSlice() {
  S.lastSweep = Date.now();
  if (!S.inline) return;
  try { if (store.sweep(S.inline, Date.now(), { budgetMs: 20, chunk: 50, vacuumPages: 64 }).more) setTimeout(sweepSlice, 100).unref(); }
  catch { S.stats.errors++; }
}

const digest = (s) => createHash("sha256").update(s).digest("base64url").slice(0, 22);
// Text nodes worth keeping: role/kind come from the scanner source ("user/text", "user/tool_result", ...).
function cap(text, kind) {
  const limit = kind === "tool_result" || kind === "function_call_output" ? TOOL_CAP : PROMPT_CAP;
  return text.length > limit ? [text.slice(0, limit), 1] : [text, 0];
}

const str = (v) => (typeof v === "string" ? v : "");
// Roles come from the client; only known names are stored, so a role can never carry a value.
const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function", "model"]);
const json = (v) => { try { return v && typeof v === "object" ? JSON.stringify(v).slice(0, TOOL_CAP + 1) : str(v); } catch { return ""; } };
function parts(content, role, path, out, kind = "text", toolById, toolId = null, resolvedName = null) {
  // The tool name (resolved by the caller, or looked up from the call id) attaches to every node here.
  const namedTool = resolvedName || (toolId && toolById?.get(String(toolId)));
  if (typeof content === "string") return void out.push({ text: content, role, kind, path, ...(namedTool && { tool: namedTool }) });
  if (!Array.isArray(content)) return;
  content.forEach((b, j) => {
    const at = `${path}[${j}]`;
    if (typeof b === "string") return void out.push({ text: b, role, kind, path: at, ...(namedTool && { tool: namedTool }) });
    if (!b || typeof b !== "object") return;
    // Thinking, images and files are skipped: signed, binary, or scanned elsewhere.
    if (b.type === "tool_result") return parts(b.content, role, `${at}.content`, out, "tool_result", toolById, toolId || str(b.tool_use_id) || null, namedTool || null);
    if (b.type === "tool_use") return void out.push({ text: `${str(b.name)} ${json(b.input)}`, role, kind: "tool_use", path: at, ...(typeof b.name === "string" && b.name && { tool: str(b.name).slice(0, 100) }) });
    if (typeof b.text === "string" && b.type !== "thinking") {
      const tool = namedTool || (toolId && toolById?.get(String(toolId))) || toolById?.get(String(b.tool_use_id || ""));
      out.push({ text: b.text, role, kind, path: `${at}.text`, ...(tool && { tool }) });
    }
  });
}
/** References to the request's text, taken before redaction rewrites the body. Strings are not copied. */
export function collect(body) {
  const out = [];
  if (!body || typeof body !== "object") return out;
  // Paths must equal scanBody's, so request-scan findings line up: root keys outside its PATH_KEYS are "[field:N]".
  const keys = Object.keys(body), field = (k) => `[field:${keys.indexOf(k)}]`;
  if (body.system) parts(body.system, "system", field("system"), out);
  if (typeof body.instructions === "string") out.push({ text: body.instructions, role: "system", kind: "text", path: field("instructions") });
  if (typeof body.input === "string") out.push({ text: body.input, role: "user", kind: "text", path: "input" });
  const list = Array.isArray(body.messages) ? ["messages", body.messages] : Array.isArray(body.input) ? ["input", body.input] : null;
  if (!list) return out;
  // Pair tool results with their tool name: Response-API `function_call` rows, Claude `tool_use` blocks,
  // and `function_call_output.call_id`/`tool_call_id`. The name is an identifier, never a value.
  const toolById = new Map();
  for (const m of list[1]) {
    if (m?.type === "function_call" && str(m.call_id)) toolById.set(str(m.call_id), str(m.name).slice(0, 100));
    // OpenAI chat tool_calls: the id pairs with a later tool-role message's tool_call_id.
    if (Array.isArray(m?.tool_calls)) for (const c of m.tool_calls) if (str(c?.id) && str(c?.function?.name)) toolById.set(str(c.id), str(c.function.name).slice(0, 100));
    let content = m?.content;
    if (typeof content === "string" || !Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "tool_use" && str(b.name)) toolById.set(str(b.id), str(b.name).slice(0, 100));
  }
  list[1].forEach((m, i) => {
    if (!m || typeof m !== "object") return;
    const at = `${list[0]}[${i}]`, role = ROLES.has(m.role) ? m.role : m.role === undefined ? "tool" : "other";
    if (m.type === "function_call") return out.push({ text: `${str(m.name)} ${str(m.arguments)}`, role: "assistant", kind: "tool_use", path: at, ...(str(m.name) && { tool: str(m.name).slice(0, 100) }) });
    // A tool-role message's name (tool_call_id against toolById) is also its own text nodes' tool.
    const onceTool = role === "tool" && toolById?.get(str(m.tool_call_id || str(m.call_id)));
    if (m.type === "function_call_output") {
      const tool = onceTool || toolById?.get(str(m.call_id ?? m.tool_call_id));
      return out.push({ text: json(m.output), role: "tool", kind: "tool_result", path: at, ...(tool && { tool }) });
    }
    parts(m.content, role, `${at}.content`, out, role === "tool" ? "tool_result" : "text", toolById, role === "tool" ? str(m.tool_call_id || str(m.call_id)) || null : null, onceTool || null);
    if (Array.isArray(m.tool_calls)) m.tool_calls.forEach((c, k) => out.push({ text: `${str(c?.function?.name)} ${str(c?.function?.arguments)}`, role, kind: "tool_use", path: `${at}.tool_calls[${k}]`, ...(str(c?.function?.name) && { tool: str(c?.function?.name).slice(0, 100) }) }));
  });
  return out;
}

/** Picks the strings to store: every string not stored before in this session. Without a session: the latest
 *  string and any string with a finding (those nodes need `findings`).
 *  `nodes`: [{ text, role, kind, path }] in request order; texts are originals (before redaction).
 *  Memory only: the session's digests are already loaded when this runs. */
export function pick(nodes, sessionId) {
  const known = sessionId ? S.seen.get(sessionId) : null, waiting = sessionId ? S.pending.get(sessionId) : null;
  if (known) { S.seen.delete(sessionId); S.seen.set(sessionId, known); } // most recently used last
  const out = [], selected = new Set();
  let bytes = 0;
  nodes.forEach((n, i) => {
    if (!n.text || n.text.length < 2 || bytes >= REQUEST_CAP) return;
    const d = digest(`${n.role}\0${n.kind}\0${n.text}`);
    // No session: nothing to dedupe against, so keep only the latest message and messages with findings.
    if (sessionId ? known?.has(d) || waiting?.has(d) || selected.has(d) : !n.findings.length && i !== nodes.length - 1) return;
    selected.add(d);
    out.push({ ...n, digest: d });
    bytes += Math.min(n.text.length, PROMPT_CAP);
  });
  return out;
}
// `touch` records a session with nothing stored yet, so its next request is not parked again.
function remember(sessionId, digests, touch = false) {
  if (!sessionId || (!digests.length && !touch)) return;
  let set = S.seen.get(sessionId);
  if (!set) set = new Set();
  S.seen.delete(sessionId); S.seen.set(sessionId, set); // most recent last
  for (const d of digests) set.add(d);
  let total = 0;
  for (const s of S.seen.values()) total += s.size;
  for (const [k, s] of S.seen) { if (total <= SEEN_MAX && S.seen.size <= SEEN_SESSIONS) break; total -= s.size; S.seen.delete(k); }
}

/** Queues masked records; never blocks the request and never touches the database. Masking and the rescan
 *  happen here (CPU only, and only for text this session has not stored yet); the write is batched.
 *  Returns how many records were queued, or held until the session's digests are loaded.
 *  Full queue: the record is dropped and counted. */
export function capture(meta, library, detector) {
  if (!meta.nodes.length || typeof library?.maskText !== "function") return 0;
  try {
    // Routing labels are identifiers, never values: validate each, fail closed to null.
    const routing = { provider: cleanId(meta.provider, detector), combo: cleanId(meta.combo, detector), account: cleanId(meta.account, detector) };
    return ingest({ ...meta, routing, file: promptsFile(), library, detector });
  } catch { S.stats.errors++; return 0; }
}
const ID_RE = /^[A-Za-z0-9._:/+-]{1,64}$/;
/** A routing label is an identifier, never a value. Scanner hits or an `@` fail closed: the field stores null. */
export function cleanId(value, detector) {
  if (typeof value !== "string" || !ID_RE.test(value)) return null;
  try { return detector.scan(value).length ? null : value; }
  catch { return null; }
}

export function updateRouting(requestId, routing, detector) {
  if (process.env.PII_GUARD_PROMPTS === "off") return;
  const fields = Object.fromEntries(["provider", "combo", "account"].map(key => [key, cleanId(routing?.[key], detector)]));
  const file = promptsFile();
  for (const op of S.queue) if (op.row && op.file === file && op.row.requestId === requestId) Object.assign(op.row, fields);
  for (const jobs of S.parked.values()) for (const job of jobs) if (job.file === file && job.requestId === requestId) Object.assign(job.routing, fields);
  // Rows of this request that a batch already wrote are updated by the next batch. No rows, no work.
  if (!S.captured.has(`${file}\0${requestId}`)) return;
  S.queue.push({ file, route: { requestId, ...fields } });
  schedule();
}

function park(job) {
  job.bytes = job.nodes.reduce((sum, n) => sum + (n.text?.length || 0), 0);
  if (S.parkedJobs >= PARK_MAX || S.parkedBytes + job.bytes > QUEUE_BYTES) { S.stats.dropped++; return 0; }
  const key = `${job.file}\0${job.sessionId}`;
  let jobs = S.parked.get(key);
  if (!jobs) S.parked.set(key, jobs = []);
  jobs.push(job); S.parkedJobs++; S.parkedBytes += job.bytes;
  if (!workerMode()) schedule(); // the fallback loads the digests when the batch timer fires
  else if (!S.seedWait.has(key)) {
    const wait = rpc("seed", { sessionId: job.sessionId }, job.file)
      .then((digests) => seeded(key, job.sessionId, digests), () => { S.stats.errors++; unpark(key); })
      .finally(() => S.seedWait.delete(key));
    S.seedWait.set(key, wait);
  }
  return job.nodes.length;
}
function unpark(key) {
  const jobs = S.parked.get(key) || [];
  S.parked.delete(key);
  for (const job of jobs) { S.parkedJobs--; S.parkedBytes -= job.bytes; }
  return jobs;
}
function seeded(key, sessionId, digests) {
  remember(sessionId, Array.isArray(digests) ? digests : [], true);
  for (const job of unpark(key)) { try { ingest(job, true); } catch { S.stats.errors++; } }
}

// `loaded`: the session's digests were just loaded, so the job is never parked twice.
function ingest(job, loaded = false) {
  const { nodes, bodyFindings = [], requestId, sessionId, model, routing, tool: rawTool, client, file, library, detector } = job;
  if (sessionId && !loaded && !S.seen.has(sessionId)) return park(job);
  const analyse = (n) => {
    // The request scan used context (sibling keys like "phone"); a rescan of the bare string may miss those.
    // Same path: reuse its spans. Inside the node but unmatched by hash: unsafe, so the node is not stored.
    const own = detector.scan(n.text), inside = bodyFindings.filter((f) => f.path === n.path || f.path.startsWith(`${n.path}.`) || f.path.startsWith(`${n.path}[`));
    const exact = inside.filter((f) => f.path === n.path && f.end <= n.text.length && !own.some((o) => o.start === f.start && o.end === f.end));
    n.findings = [...own, ...exact];
    // Every request-scan hit inside the node needs its own masked span: compare counts per hash.
    const need = new Map(), have = new Map();
    for (const f of inside) need.set(f.hash, (need.get(f.hash) || 0) + 1);
    for (const f of n.findings) have.set(f.hash, (have.get(f.hash) || 0) + 1);
    n.unsafe = [...need].some(([h, c]) => (have.get(h) || 0) < c);
  };
  // With a session only the strings not stored before are scanned: a resent conversation costs its digests.
  let chosen;
  if (sessionId) { chosen = pick(nodes, sessionId); chosen.forEach(analyse); }
  else { nodes.forEach(analyse); chosen = pick(nodes, null); }
  const ts = Date.now();

  let captured = 0;
  for (const n of chosen) {
    if (n.unsafe) { S.stats.unsafe++; continue; }
    let masked;
    try {
      const [text, cut] = cap(library.maskText(n.text, n.findings), n.kind);
      // Fail closed: anything still detected after masking means a span was missed.
      if (detector.scan(text).length) { S.stats.unsafe++; continue; }
      masked = { ts, requestId, sessionId: sessionId || null, model: model || null, ...routing, client: client || null, role: n.role, kind: n.kind, path: n.path, digest: n.digest, tool: cleanId(rawTool ?? n.tool, detector), text, cut, hashes: [...new Set(n.findings.map((f) => f.hash))].join(" ") };
    } catch { S.stats.errors++; continue; }
    if (S.rows >= QUEUE_MAX || S.queuedBytes + S.inflightBytes + masked.text.length > QUEUE_BYTES) { S.stats.dropped++; continue; }
    S.queue.push({ file, row: masked }); S.rows++; S.queuedBytes += masked.text.length;
    captured++;
    if (sessionId) { let set = S.pending.get(sessionId); if (!set) S.pending.set(sessionId, set = new Set()); set.add(n.digest); }
  }
  if (captured) {
    const key = `${file}\0${requestId}`;
    S.captured.delete(key); S.captured.set(key, true);
    if (S.captured.size > CAPTURED_MAX) S.captured.delete(S.captured.keys().next().value);
    schedule();
  }
  return captured;
}

function schedule() {
  if (S.rows >= FLUSH_ROWS || S.queuedBytes >= FLUSH_BYTES) {
    if (S.soon) return;
    S.soon = true;
    setImmediate(() => { S.soon = false; void (workerMode() ? flush() : flushInline(INLINE_SLICE)); });
  } else if (!S.timer) {
    S.timer = setTimeout(() => { S.timer = null; void (workerMode() ? flush() : flushInline(INLINE_SLICE)); }, FLUSH_MS);
    S.timer.unref?.();
  }
}
function takeBatches(limit = Infinity) {
  const ops = S.queue.length > limit ? S.queue.splice(0, limit) : S.queue;
  if (ops === S.queue) S.queue = [];
  S.rows = 0; S.queuedBytes = 0;
  for (const op of S.queue) if (op.row) { S.rows++; S.queuedBytes += op.row.text.length; }
  const byFile = new Map();
  for (const op of ops) { let list = byFile.get(op.file); if (!list) byFile.set(op.file, list = []); list.push(op); }
  return byFile;
}
function settled(ops, ok) {
  const rows = ops.filter((op) => op.row).map((op) => op.row);
  if (ok) S.stats.stored += rows.length; else S.stats.dropped += rows.length;
  for (const r of rows) {
    if (!r.sessionId) continue;
    const set = S.pending.get(r.sessionId);
    set?.delete(r.digest);
    if (set && !set.size) S.pending.delete(r.sessionId);
    if (ok) remember(r.sessionId, [r.digest]);
  }
}
/** Writes everything captured so far. The promise resolves when the batch is stored (or dropped); on the
 *  fallback path the write has already happened when this returns. Never rejects. */
export function flush() {
  clearTimeout(S.timer); S.timer = null;
  if (workerMode()) return flushWorker().catch(() => { S.stats.errors++; });
  flushInline();
  return Promise.resolve();
}
async function flushWorker() {
  while (S.seedWait.size) await Promise.allSettled([...S.seedWait.values()]);
  for (const [file, ops] of takeBatches()) {
    const bytes = ops.reduce((sum, op) => sum + (op.row ? op.row.text.length : 0), 0);
    S.inflightBytes += bytes;
    try { await rpc("write", { ops: ops.map(({ row, route }) => (row ? { row } : { route })) }, file); settled(ops, true); }
    catch { S.stats.errors++; settled(ops, false); }
    finally { S.inflightBytes -= bytes; }
  }
}
// Fallback writer on this thread. The timers pass `limit`: a batch is then written a slice at a time, with
// the event loop free in between, because one insert costs about a millisecond in a large store.
function flushInline(limit = Infinity) {
  for (const [key, jobs] of [...S.parked]) {
    const { file, sessionId } = jobs[0];
    let digests = [];
    try { const h = inline(file); if (h) digests = store.digestsFor(h, sessionId); } catch { S.stats.errors++; }
    seeded(key, sessionId, digests);
  }
  clearTimeout(S.timer); S.timer = null;
  for (const [file, ops] of takeBatches(limit)) {
    const h = inline(file);
    if (!h) { settled(ops, false); continue; }
    try { store.writeOps(h, ops); settled(ops, true); }
    catch { S.stats.errors++; settled(ops, false); }
  }
  if (S.queue.length && !S.soon) { S.soon = true; setImmediate(() => { S.soon = false; flushInline(limit); }); }
  if (S.inline && Date.now() - S.lastSweep > HOUR) setTimeout(sweepSlice, 0).unref();
}

/** Retention on this thread's connection, run to the end: a test helper and the fallback's manual sweep.
 *  Returns the number of rows removed. */
export function sweep(now = Date.now(), capBytes) {
  S.lastSweep = Date.now();
  if (!S.inline) return 0;
  try { return store.sweep(S.inline, now, { capBytes }).removed; } catch { S.stats.errors++; return 0; }
}
/** Retention where the store lives (the writer thread when there is one). */
export function sweepAsync(now = Date.now(), capBytes) {
  if (!workerMode()) { inline(); return Promise.resolve(sweep(now, capBytes)); }
  return rpc("sweep", { now, capBytes });
}

// Synchronous reads on this thread: the fallback path and tests. The dashboard routes use the *Async forms.
export function search(args) { return store.search(inline(), args); }
export function sessions(args) { return store.sessions(inline(), args); }
export function conversation(args) { return store.conversation(inline(), args); }
export function message(id) { return store.message(inline(), id); }
// Same results, read in the writer thread so a large session or a search never holds the gateway thread.
const read = (name, sync) => (args) => (workerMode() ? rpc(name, args) : Promise.resolve().then(() => sync(args)));
export const searchAsync = read("search", search);
export const sessionsAsync = read("sessions", sessions);
export const conversationAsync = read("conversation", conversation);
export const messageAsync = read("message", message);

/** Test helper: forget in-memory dedupe, as a restart does. */
export function _forget() { S.seen.clear(); }
/** Test helper: back to a cold start. Resolves when the writer thread, if any, has stopped. */
export function _reset() {
  clearTimeout(S.timer); clearInterval(S.sweepTimer);
  store.closeDb(S.inline);
  const w = S.worker;
  S.worker = null;
  for (const id of [...S.rpcs.keys()]) settle(id, new Error("prompt store reset"));
  const { stats: counters } = S;
  Object.assign(S, fresh(), { stats: Object.assign(counters, { stored: 0, dropped: 0, unsafe: 0, errors: 0 }) });
  return w ? w.terminate().then(() => {}, () => {}) : Promise.resolve();
}
