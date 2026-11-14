let cached = null;

export function hasSessionColumn(db) {
  if (cached !== null) return cached;
  try {
    const cols = db.all("PRAGMA table_info(usageHistory)");
    cached = Array.isArray(cols) && cols.some((c) => c && c.name === "session");
  } catch {
    cached = false;
  }
  return cached;
}

export function resetSessionColumnCache() { cached = null; resetSessionBackfillCache(); }

// True once migration 003's batched backfill has copied every meta.session
// into the session column. Until then queries must keep the COALESCE. The
// read worker has its own copy of this module, so "not yet" is re-read from
// _meta at most every 30 s; "done" is final.
const BACKFILL_KEY = "usageHistorySessionBackfill";
const BACKFILL_RECHECK_MS = 30_000;
let backfilled = false;
let backfillCheckedAt = 0;

export function sessionBackfilled(db) {
  if (backfilled) return true;
  const now = Date.now();
  if (now - backfillCheckedAt < BACKFILL_RECHECK_MS) return false;
  backfillCheckedAt = now;
  try {
    backfilled = db.get("SELECT value FROM _meta WHERE key = ?", [BACKFILL_KEY])?.value === "done";
  } catch {
    backfilled = false;
  }
  return backfilled;
}

export function resetSessionBackfillCache() { backfilled = false; backfillCheckedAt = 0; }

export function sessionSql(has, filled = false) {
  if (!has) return "json_extract(meta,'$.session')";
  return filled ? "session" : "COALESCE(session, json_extract(meta,'$.session'))";
}

export function sessionMatchSql(has, filled = false) {
  if (!has) return "json_extract(meta,'$.session') = ?";
  return filled ? "session = ?" : "(session = ? OR (session IS NULL AND json_extract(meta,'$.session') = ?))";
}

export function sessionMatchParams(sessionId, has, filled = false) {
  return has && !filled ? [sessionId, sessionId] : [sessionId];
}

export function statusSql() {
  return `CASE WHEN COALESCE(NULLIF(json_extract(meta,'$.status'),''), NULLIF(status,''), 'ok') IN ('ok','success')
    THEN 'ok' ELSE COALESCE(NULLIF(json_extract(meta,'$.status'),''), NULLIF(status,''), 'ok') END`;
}

export function roleSql() {
  // Matches meta.js resolveRoleName/bgRole: haiku inside Claude Code sessions is
  // background; model-named combos (claude-*, gpt-*, provider/model, any id with
  // a version digit or separator) are not roles and map to direct.
  return `CASE
    WHEN json_extract(meta, '$.combo') = 'claude-haiku-5-5'
     AND (LOWER(COALESCE(json_extract(meta, '$.ua'), '')) LIKE 'claude-cli%'
          OR LOWER(COALESCE(json_extract(meta, '$.ua'), '')) LIKE '%claude-code%')
    THEN 'background'
    WHEN COALESCE(json_extract(meta, '$.combo'), '') IN ('', 'daily', 'invalid') THEN 'direct'
    WHEN json_extract(meta, '$.combo') GLOB '*[0-9]*'
      OR instr(json_extract(meta, '$.combo'), '/') > 0
      OR instr(json_extract(meta, '$.combo'), '.') > 0
      OR instr(json_extract(meta, '$.combo'), '_') > 0
      OR instr(json_extract(meta, '$.combo'), '-') > 0
    THEN 'direct'
    ELSE json_extract(meta, '$.combo')
  END`;
}
