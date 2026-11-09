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

export function resetSessionColumnCache() { cached = null; }

export function sessionSql(has) {
  return has
    ? "COALESCE(session, json_extract(meta,'$.session'))"
    : "json_extract(meta,'$.session')";
}

export function sessionMatchSql(has) {
  return has
    ? "(session = ? OR (session IS NULL AND json_extract(meta,'$.session') = ?))"
    : "json_extract(meta,'$.session') = ?";
}

export function statusSql() {
  return `CASE WHEN COALESCE(NULLIF(json_extract(meta,'$.status'),''), NULLIF(status,''), 'ok') IN ('ok','success')
    THEN 'ok' ELSE COALESCE(NULLIF(json_extract(meta,'$.status'),''), NULLIF(status,''), 'ok') END`;
}

export function roleSql() {
  return `CASE
    WHEN json_extract(meta, '$.combo') = 'claude-haiku-5-5'
     AND (LOWER(json_extract(meta, '$.ua')) LIKE 'claude-cli%' OR LOWER(json_extract(meta, '$.ua')) LIKE '%claude-code%')
    THEN 'background'
    ELSE COALESCE(NULLIF(json_extract(meta, '$.combo'), ''), 'direct')
  END`;
}
