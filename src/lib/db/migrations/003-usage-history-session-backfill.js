// Rows written before migration 002 keep their session only in meta JSON, so
// every Agents query had to read COALESCE(session, json_extract(meta, ...)).
// This migration only records where the backfill stands. The copy itself runs
// later in small id-range batches (backfillSessionBatch), driven by
// src/lib/agents/sessionBackfill.js, so startup never holds a long write lock
// on a large usageHistory table. Queries keep the COALESCE until the state
// reads "done".
import { getMetaSync, setMetaSync } from "../helpers/metaStore.js";

export const SESSION_BACKFILL_KEY = "usageHistorySessionBackfill";
export const SESSION_BACKFILL_DONE = "done";

/**
 * Copy meta.session into the session column for the next `limit` rows by id.
 * State in _meta is the last id handled, or "done". Safe to call again at any
 * time; each call is one short transaction.
 */
export function backfillSessionBatch(db, limit = 2000) {
  const state = getMetaSync(db, SESSION_BACKFILL_KEY, "0");
  if (state === SESSION_BACKFILL_DONE) return { done: true, updated: 0 };
  const cursor = Number.parseInt(state, 10) || 0;
  const size = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 2000, 20_000));
  const end = db.get(
    "SELECT MAX(id) AS m FROM (SELECT id FROM usageHistory WHERE id > ? ORDER BY id LIMIT ?)",
    [cursor, size]
  )?.m;
  if (end == null) {
    // Past the last row. Rows inserted from now on set the column themselves.
    setMetaSync(db, SESSION_BACKFILL_KEY, SESSION_BACKFILL_DONE);
    return { done: true, updated: 0 };
  }
  let updated = 0;
  db.transaction(() => {
    const result = db.run(
      `UPDATE usageHistory
       SET session = json_extract(meta, '$.session')
       WHERE id > ? AND id <= ? AND session IS NULL
         AND json_valid(meta) AND json_extract(meta, '$.session') IS NOT NULL`,
      [cursor, end]
    );
    updated = Number(result?.changes || 0);
    setMetaSync(db, SESSION_BACKFILL_KEY, end);
  });
  return { done: false, updated, cursor: end };
}

export default {
  version: 3,
  name: "usage-history-session-backfill",
  up(db) {
    if (getMetaSync(db, SESSION_BACKFILL_KEY, null) != null) return;
    const columns = db.all("PRAGMA table_info(usageHistory)");
    const empty = columns.length === 0 || !db.get("SELECT 1 AS x FROM usageHistory LIMIT 1");
    setMetaSync(db, SESSION_BACKFILL_KEY, empty ? SESSION_BACKFILL_DONE : "0");
  },
};
