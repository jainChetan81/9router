// SQLite side of the masked prompt store. No module state: every function takes the handle from openDb(),
// so the same code runs in the writer thread (promptWorker.mjs) and, as a fallback, on the main thread.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TTL_MS = 14 * 864e5;
// Cap on the database file's used pages (text + indexes + FTS), and on the stored text bytes.
// 512 MiB holds the full 14-day TTL at the rate seen in production (about 40 MiB a day);
// PII_GUARD_PROMPTS_MAX_MB overrides it. Read on every sweep, so the writer thread and the
// fallback agree and a test can change it.
export const DEFAULT_STORE_MB = 512;
export function storeCapBytes(env = process.env) {
  const mb = Number(env.PII_GUARD_PROMPTS_MAX_MB);
  return Math.floor((Number.isFinite(mb) && mb >= 1 ? mb : DEFAULT_STORE_MB) * 1024 * 1024);
}
// Eviction stops this far under the cap, so a store at the cap does not evict on every batch.
const CAP_SLACK = 0.95;
const SWEEP_CHUNK = 400;

// secure_delete stays ON: this store is only partially masked (names and custom secrets stay readable), so a
// row that expires or is evicted must leave no readable text in freed pages. The cost is paid by the writer.
// journal_size_limit keeps the -wal file from staying large after a burst.
const PRAGMAS = (busy) => `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=${busy}; PRAGMA journal_size_limit=16777216;`;
const REQUIRED = ["provider", "combo", "account", "tool"];

// Idempotent inserts: a digest identifies one message of a request, in a session or without one. After an
// RPC timeout the writer may still store a batch that is then sent again, and the shutdown flush rewrites
// batches the writer may already hold, so writing a row twice must store it once.
// A plain UNIQUE index treats every NULL session_id as distinct, so rows without a session were never
// deduplicated; the index is on COALESCE(session_id, '') instead ('' is never stored as a session id).
// Runs once per database: remove existing duplicates, create the new index, drop the old one, in one
// transaction, so a crash or a lock leaves the old state and the next open tries again.
const DEDUPE_INDEX = "messages_dedupe2";
function migrateDedupe(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(DEDUPE_INDEX)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const removed = Number(db.prepare(`DELETE FROM messages WHERE digest IS NOT NULL AND rowid NOT IN (
        SELECT MIN(rowid) FROM messages WHERE digest IS NOT NULL GROUP BY COALESCE(session_id, ''), request_id, path, digest)`).run().changes);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUPE_INDEX} ON messages(COALESCE(session_id, ''), request_id, path, digest);
      DROP INDEX IF EXISTS messages_dedupe;`);
    // The byte counter (when it exists already) must not count the rows just removed.
    if (removed) db.exec("UPDATE meta SET value = (SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM messages) WHERE key = 'text_bytes'");
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

// A failed open (a lock held by another process during a migration, a full disk) is tried again after
// 30 s, then 2 min, then every 10 min: one bad moment must not keep the store off until a restart.
const OPEN_RETRY_MS = [30_000, 120_000, 600_000];
export function openRetryMs(failures) {
  return OPEN_RETRY_MS[Math.min(Math.max(1, failures), OPEN_RETRY_MS.length) - 1];
}

/** Opens (and migrates) the store. Returns `{ db, file }` or null when it cannot be used. */
export function openDb(file, { busyTimeout = 0 } = {}) {
  let db = null;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(file), 0o700);
    // Loaded lazily so the module stays importable where node:sqlite is missing.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const connect = () => {
      const d = new DatabaseSync(file);
      d.exec(PRAGMAS(busyTimeout));
      if (d.prepare("PRAGMA auto_vacuum").get().auto_vacuum !== 2) d.exec("PRAGMA auto_vacuum=INCREMENTAL; VACUUM;");
      return d;
    };
    db = connect();
    db.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL, session_id TEXT,
        model TEXT, provider TEXT, combo TEXT, account TEXT, client TEXT, role TEXT, kind TEXT, path TEXT, text TEXT NOT NULL, cut INTEGER NOT NULL DEFAULT 0, hashes TEXT NOT NULL DEFAULT '', digest TEXT, tool TEXT);
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS messages_request ON messages(request_id);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    migrateDedupe(db);
    // Migration for rows a schema without the routing columns created: add them, old rows stay NULL.
    // A lock or a lost race against another opener retries a few times; missing columns mean the
    // connection is not used (prompts stay off) rather than INSERTs failing on every row.
    const columns = () => db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const missing = REQUIRED.filter((c) => !columns().includes(c));
      if (!missing.length) break;
      try { for (const col of missing) db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`); }
      catch (e) {
        if (/duplicate column/i.test(String(e?.message))) continue; // re-read all columns after a lost race
        if (!/busy|locked/i.test(String(e?.message)) || attempt === 4) throw e;
        db.close();
        db = connect();
      }
    }
    if (!REQUIRED.every((c) => columns().includes(c))) throw new Error("prompt store schema is missing columns");
    // Stored text bytes, kept current by every insert and delete. Counted from the table once, when the
    // counter is first created; after that no sweep reads the whole table again.
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'text_bytes'").get()) {
      db.exec("INSERT OR IGNORE INTO meta (key, value) SELECT 'text_bytes', COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM messages");
    }
    for (const f of [file, `${file}-wal`, `${file}-shm`]) try { chmodSync(f, 0o600); } catch {}
    return { db, file };
  } catch {
    try { db?.close(); } catch {}
    return null;
  }
}

export function closeDb(h) { try { h?.db.close(); } catch {} }

export function textBytes(h) { return Number(h.db.prepare("SELECT value FROM meta WHERE key = 'text_bytes'").get()?.value || 0); }
/** Bytes of database pages in use (free pages excluded): what the file shrinks to after a vacuum. */
export function usedBytes(h) {
  const n = (name) => Number(Object.values(h.db.prepare(`PRAGMA ${name}`).get())[0]);
  return (n("page_count") - n("freelist_count")) * n("page_size");
}

/** One transaction for a whole batch. `ops` keeps request order: { row } inserts, { route } updates a request's rows.
 *  Inserts are idempotent on (session_id or '', request_id, path, digest): a batch written a second time
 *  (the shutdown flush, a retry) inserts nothing. */
export function writeOps(h, ops) {
  const d = h.db;
  const ins = d.prepare("INSERT OR IGNORE INTO messages (ts, request_id, session_id, model, provider, combo, account, client, role, kind, path, text, cut, hashes, digest, tool) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const upd = d.prepare("UPDATE messages SET provider=?, combo=?, account=? WHERE request_id=?");
  let stored = 0, bytes = 0;
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const op of ops) {
      if (op.route) { upd.run(op.route.provider ?? null, op.route.combo ?? null, op.route.account ?? null, op.route.requestId); continue; }
      const r = op.row;
      const info = ins.run(r.ts, r.requestId, r.sessionId, r.model, r.provider, r.combo, r.account, r.client, r.role, r.kind, r.path, r.text, r.cut, r.hashes, r.digest, r.tool);
      if (Number(info?.changes) === 0) continue; // already stored: the retry hit a duplicate
      stored++; bytes += Buffer.byteLength(r.text);
    }
    if (bytes) d.prepare("UPDATE meta SET value = value + ? WHERE key = 'text_bytes'").run(bytes);
    d.exec("COMMIT");
  } catch (e) { try { d.exec("ROLLBACK"); } catch {} throw e; }
  return { stored, bytes };
}

/** Message digests already stored for a session: seeds the in-memory dedupe after a restart or an eviction. */
export function digestsFor(h, sessionId) {
  return h.db.prepare("SELECT digest FROM messages WHERE session_id = ? AND digest IS NOT NULL").all(sessionId).map((x) => x.digest);
}

// Deletes one chunk of the oldest rows (all of them, or only those older than `before`) and keeps the byte counter exact.
function deleteOldest(h, limit, before) {
  const d = h.db;
  d.exec("BEGIN IMMEDIATE");
  try {
    const rows = before === undefined
      ? d.prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY ts, id LIMIT ?) RETURNING length(CAST(text AS BLOB)) AS n").all(limit)
      : d.prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE ts < ? ORDER BY ts, id LIMIT ?) RETURNING length(CAST(text AS BLOB)) AS n").all(before, limit);
    let bytes = 0;
    for (const r of rows) bytes += Number(r.n);
    if (bytes) d.prepare("UPDATE meta SET value = MAX(0, value - ?) WHERE key = 'text_bytes'").run(bytes);
    d.exec("COMMIT");
    return { rows: rows.length, bytes };
  } catch (e) { try { d.exec("ROLLBACK"); } catch {} throw e; }
}

/** Retention: rows past the TTL go first, then the oldest rows until the store is back under its cap.
 *  Works in chunks from the stored byte counter and the page counts; it never scans the table.
 *  `budgetMs` and `vacuumPages` bound one call; `more` is true when another call has work left. */
export function sweep(h, now = Date.now(), { capBytes = storeCapBytes(), budgetMs = Infinity, chunk = SWEEP_CHUNK, vacuumPages = Infinity } = {}) {
  const started = Date.now(), spent = () => Date.now() - started >= budgetMs;
  let removed = 0, more = false;
  for (;;) {
    const r = deleteOldest(h, chunk, now - TTL_MS);
    removed += r.rows;
    if (r.rows < chunk) break;
    if (spent()) { more = true; break; }
  }
  // The text cap is exact. The page cap also covers indexes and the FTS index, which shrink a little behind
  // the rows; each round removes the text share of the excess, measured again after every chunk.
  const over = () => {
    const text = textBytes(h), used = usedBytes(h);
    if (text <= capBytes && used <= capBytes) return 0;
    const target = capBytes * CAP_SLACK;
    return Math.max(text - target, used > capBytes ? (used - target) * (text / Math.max(used, 1)) : 0);
  };
  // Rows to remove for `bytes` of text, from the average row (ids are dense enough for an estimate).
  const rowsFor = (bytes) => {
    const span = h.db.prepare("SELECT MAX(id) - MIN(id) + 1 AS n FROM messages").get();
    const average = Math.max(1, textBytes(h) / Math.max(1, Number(span?.n) || 1));
    return Math.min(chunk, Math.max(1, Math.ceil(bytes / average)));
  };
  let excess = more ? 0 : over();
  while (excess > 0) {
    const r = deleteOldest(h, rowsFor(excess));
    if (!r.rows) break;
    removed += r.rows; excess -= r.bytes;
    if (excess <= 0) excess = over();
    if (excess > 0 && spent()) { more = true; break; }
  }
  // Give freed pages back to the file system, at most `vacuumPages` per call.
  const free = Number(h.db.prepare("PRAGMA freelist_count").get().freelist_count);
  if (free) { h.db.exec(`PRAGMA incremental_vacuum(${Math.min(free, vacuumPages)})`); if (free > vacuumPages) more = true; }
  return { removed, more };
}

// Words and word starts: "repeat this" matches both words in order; quotes stop FTS syntax injection.
function ftsQuery(q) {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) || [];
  return words.slice(0, 12).map((w, i, a) => `"${w}"${i === a.length - 1 ? "*" : ""}`).join(" ");
}
const COLS = "m.id, m.ts, m.request_id AS requestId, m.session_id AS sessionId, m.model, m.provider, m.combo, m.account, m.client, m.role, m.kind, m.path, m.cut, m.hashes, m.tool";

/** Search, newest first, 50 per page. Snippets only; full text comes from `message(id)`. */
export function search(h, { q = "", sessionId = "", requestId = "", hash = "", from = 0, to = Date.now(), before = Infinity, limit = 50 } = {}) {
  if (!h) return { rows: [], next: null, unavailable: true };
  const d = h.db;
  const where = ["m.ts >= ?", "m.ts <= ?"], args = [Math.max(from, Date.now() - TTL_MS), to];
  if (Number.isFinite(before)) { where.push("m.id < ?"); args.push(before); }
  if (sessionId) { where.push("m.session_id = ?"); args.push(sessionId); }
  if (requestId) { where.push("m.request_id = ?"); args.push(requestId); }
  if (hash) { where.push("(' ' || m.hashes || ' ') LIKE ?"); args.push(`% ${hash} %`); }
  const fts = ftsQuery(q);
  if (q && !fts) return { rows: [], next: null };
  const sql = fts
    ? `SELECT ${COLS}, snippet(messages_fts, 0, '\u0001', '\u0002', '…', 24) AS snip FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? AND ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`
    : `SELECT ${COLS}, substr(m.text, 1, 240) AS snip FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`;
  const n = Math.min(Math.max(1, limit), 100);
  const rows = d.prepare(sql).all(...(fts ? [fts] : []), ...args, n + 1);
  const page = rows.slice(0, n);
  return { rows: page, next: rows.length > n ? page.at(-1).id : null };
}

// Sessions view: one aggregate per stored session, newest first, paged by last_seen. Messages without a
// session_id never appear here; they stay reachable only through Prompts and per-request links.
// Unique finding values are folded from the per-message hash lists in JS: the lists are small.
export function sessions(h, { q = "", client = "", provider = "", combo = "", hash = "", findings = null, from = 0, to = Date.now(), before = Infinity, limit = 50 } = {}) {
  if (!h) return { rows: [], next: null, unavailable: true };
  const d = h.db;
  const lo = Math.max(from, Date.now() - TTL_MS);
  // The ts pair feeds two ? pairs (CTE and outer WHERE), so it repeats in the args in that order.
  const where = ["m.ts >= ?", "m.ts <= ?"], args = [lo, to, lo, to];
  // HAVING placeholders come after the outer WHERE ones, and `before` feeds an HAVING ? only,
  // so it is appended last.
  if (client) { where.push("g.clients LIKE ?"); args.push(`%\u0001${client}\u0001%`); }
  if (provider) { where.push("g.providers LIKE ?"); args.push(`%\u0001${provider}\u0001%`); }
  if (combo) { where.push("EXISTS (SELECT 1 FROM messages f WHERE f.session_id = g.session_id AND f.combo LIKE ?)"); args.push(`${combo}%`); }
  if (hash) { where.push("EXISTS (SELECT 1 FROM messages f WHERE f.session_id = g.session_id AND (' ' || f.hashes || ' ') LIKE ?)"); args.push(`% ${hash} %`); }
  if (findings === true) where.push("EXISTS (SELECT 1 FROM messages f2 WHERE f2.session_id = g.session_id AND f2.hashes != '')");
  if (findings === false) where.push("NOT EXISTS (SELECT 1 FROM messages f2 WHERE f2.session_id = g.session_id AND f2.hashes != '')");
  if (q) where.push(`(g.session_id LIKE ? OR COALESCE(g.models,'') LIKE ? OR COALESCE(g.clients,'') LIKE ? OR COALESCE(g.providers,'') LIKE ? OR EXISTS (SELECT 1 FROM messages f3 WHERE f3.session_id = g.session_id AND COALESCE(f3.combo,'') LIKE ?))`);
  if (q) args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  if (Number.isFinite(before)) { where.push("g.last < ?"); args.push(before); }
  const n = Math.min(Math.max(1, limit), 200);
  const rows = d.prepare(`WITH g AS (
      SELECT session_id, MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS messages,
        COUNT(DISTINCT request_id) AS requests,
        '\u0001' || COALESCE(GROUP_CONCAT(DISTINCT client), '') || '\u0001' AS clients,
        '\u0001' || COALESCE(GROUP_CONCAT(DISTINCT provider), '') || '\u0001' AS providers,
        '\u0001' || COALESCE(GROUP_CONCAT(DISTINCT model), '') || '\u0001' AS models
      FROM messages WHERE ts >= ? AND ts <= ? GROUP BY session_id
    ) SELECT g.session_id AS sessionId, g.first, g.last, g.messages, g.requests, g.clients, g.providers, g.models,
      MAX(m.client) AS client, MAX(m.provider) AS provider, MAX(m.combo) AS combo, MAX(m.model) AS model,
      MAX(m.hashes != '') AS hasFindings
    FROM g JOIN messages m ON m.session_id = g.session_id
    WHERE ${where.filter((w) => !w.startsWith("g.last")).join(" AND ")}
    GROUP BY g.session_id HAVING (${where.filter((w) => w.startsWith("g.last")).join(" AND ") || "1=1"})
    ORDER BY g.last DESC, g.first ASC, g.session_id ASC LIMIT ?`).all(...args, n + 1);
  // Distinct finding hashes per page, folded in JS from the per-message hash lists: one query
  // for the page instead of one per session.
  const page = rows.slice(0, n);
  const values = new Map();
  if (page.length) {
    const ph = page.map(() => "?").join(",");
    for (const row of d.prepare(`SELECT session_id, hashes FROM messages WHERE hashes != '' AND session_id IN (${ph})`).all(...page.map((r) => r.sessionId)))
      for (const hsh of row.hashes.split(" ")) { if (hsh) { values.set(row.session_id, (values.get(row.session_id) || new Set()).add(hsh)); } }
  }
  return { rows: page.map((r) => ({ ...r, values: values.get(r.sessionId)?.size || 0 })), next: rows.length > n ? rows[n - 1].last : null };
}

/** Full conversation for one session, oldest first: session metadata plus messages up to a byte cap
 *  (oldest kept), each with text and finding counts. Requests without a session never appear. */
export function conversation(h, { sessionId, from = 0, to = Date.now(), cap = 800_000, after = 0 } = {}) {
  if (!h) return { unavailable: true };
  const d = h.db;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return { error: "Invalid session id" };
  const lo = Math.max(from, Date.now() - TTL_MS);
  const meta = d.prepare(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM messages WHERE session_id = ? AND ts >= ? AND ts <= ?`).get(sessionId, lo, to);
  if (!meta?.first) return { notFound: true };
  const list = d.prepare(`SELECT id, ts, request_id AS requestId, session_id AS sessionId, model, provider, combo, account, client, role, kind, path, tool, cut, length(text) AS len, hashes
    FROM messages WHERE session_id = ? AND ts >= ? AND ts <= ? AND id > ? ORDER BY ts ASC, id ASC`)
    .all(sessionId, lo, to, after);
  // Byte cap oldest-first: truncated tail is fetched later with `after`.
  const bytes = { used: 0, over: [] }, rows = [];
  const c = Math.max(Number(cap) || 800_000, 0);
  for (const row of list) {
    if (rows.length && bytes.used + row.len > c) { bytes.over.push(row); continue; }
    bytes.used += row.len;
    rows.push(row);
  }
  const ids = rows.map((r) => r.id);
  const texts = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const ph = part.map(() => "?").join(",");
    for (const r of d.prepare(`SELECT id, text FROM messages WHERE id IN (${ph})`).all(...part)) texts.set(r.id, r.text);
  }
  // Distinct finding values in the whole session (even past the byte cap).
  const allHashes = new Set();
  for (const r of d.prepare("SELECT hashes FROM messages WHERE session_id = ? AND hashes != '' AND ts >= ? AND ts <= ?").all(sessionId, lo, to))
    for (const hsh of r.hashes.split(" ")) if (hsh) allHashes.add(hsh);
  return {
    sessionId, first: meta.first, last: meta.last, values: allHashes.size,
    messages: {
      rows: rows.map((r) => ({ ...r, text: texts.get(r.id) ?? "", values: r.hashes ? [...new Set(r.hashes.split(" "))].filter(Boolean) : [] })),
      total: list.length, shown: rows.length, over: bytes.over.length,
    },
    requests: new Set(list.map((r) => r.requestId)).size,
  };
}

export function message(h, id) {
  if (!h) return null;
  return h.db.prepare(`SELECT ${COLS}, m.text FROM messages m WHERE m.id = ? AND m.ts >= ?`).get(id, Date.now() - TTL_MS) || null;
}

export const READS = { search, sessions, conversation, message };
