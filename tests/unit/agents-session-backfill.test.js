// Migration 003: meta.session is copied into the session column in small
// batches; queries keep the COALESCE until the backfill is done.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-backfill-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
});

const stateOf = (db) => db.get("SELECT value FROM _meta WHERE key = 'usageHistorySessionBackfill'")?.value;

function seed(db, count) {
  for (let i = 0; i < count; i++) {
    const meta = i % 5 === 4 ? "{}" : JSON.stringify({ session: `s${i % 3}` });
    // Every 4th row already has the column, as rows written after migration 002 do.
    db.run("INSERT INTO usageHistory(timestamp, provider, model, meta, session) VALUES(?, 'p', 'm', ?, ?)",
      [new Date(Date.UTC(2026, 10, 7, 0, 0, i)).toISOString(), meta, i % 4 === 0 && meta !== "{}" ? `s${i % 3}` : null]);
  }
}

describe("usageHistory session backfill", () => {
  it("marks an empty database done at migration time", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(stateOf(db)).toBe("done");
    const { hasSessionColumn, sessionBackfilled, sessionSql } = await import("@/lib/agents/dbColumns.js");
    expect(sessionSql(hasSessionColumn(db), sessionBackfilled(db))).toBe("session");
  });

  it("copies old rows in bounded batches and switches queries to the plain column only when done", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { backfillSessionBatch } = await import("@/lib/db/migrations/003-usage-history-session-backfill.js");
    const cols = await import("@/lib/agents/dbColumns.js");
    seed(db, 50);
    db.run("UPDATE _meta SET value = '0' WHERE key = 'usageHistorySessionBackfill'"); // as an upgraded database starts
    const expected = db.all("SELECT id, json_extract(meta,'$.session') AS s FROM usageHistory ORDER BY id");
    const missing = () => db.get("SELECT COUNT(*) AS c FROM usageHistory WHERE session IS NULL AND json_extract(meta,'$.session') IS NOT NULL").c;
    expect(missing()).toBeGreaterThan(20);

    // Not done yet: the COALESCE stays, so half-filled data still reads right.
    cols.resetSessionColumnCache();
    expect(cols.sessionSql(cols.hasSessionColumn(db), cols.sessionBackfilled(db))).toContain("COALESCE");

    const first = backfillSessionBatch(db, 20);
    expect(first).toMatchObject({ done: false });
    expect(first.updated).toBeLessThanOrEqual(20);
    expect(Number(stateOf(db))).toBe(expected[19].id);
    expect(missing()).toBeGreaterThan(0);

    let steps = 1;
    while (!backfillSessionBatch(db, 20).done) steps++;
    expect(steps).toBe(3); // 50 rows / 20 per batch, plus the call that finds the end
    expect(stateOf(db)).toBe("done");
    expect(missing()).toBe(0);
    expect(db.all("SELECT id, session AS s FROM usageHistory ORDER BY id")).toEqual(expected);

    cols.resetSessionColumnCache();
    expect(cols.sessionBackfilled(db)).toBe(true);
    expect(cols.sessionSql(true, true)).toBe("session");
    expect(cols.sessionMatchSql(true, true)).toBe("session = ?");
    expect(cols.sessionMatchParams("x", true, true)).toEqual(["x"]);
    expect(cols.sessionMatchParams("x", true, false)).toEqual(["x", "x"]);
    // Done is final and costs nothing more.
    expect(backfillSessionBatch(db, 20)).toEqual({ done: true, updated: 0 });
  });

  it("the scheduler runs batches with gaps and stops when done", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    seed(db, 30);
    db.run("UPDATE _meta SET value = '0' WHERE key = 'usageHistorySessionBackfill'");
    const { scheduleSessionBackfill, resetSessionBackfillState } = await import("@/lib/agents/sessionBackfill.js");
    resetSessionBackfillState();
    vi.useFakeTimers();
    try {
      expect(scheduleSessionBackfill(db, { batch: 10, gapMs: 100 })).toBe(true);
      expect(scheduleSessionBackfill(db, { batch: 10, gapMs: 100 })).toBe(false); // already running
      expect(stateOf(db)).toBe("0"); // nothing runs inside the request
      vi.advanceTimersByTime(100);
      expect(stateOf(db)).not.toBe("0");
      expect(stateOf(db)).not.toBe("done");
      vi.advanceTimersByTime(1000);
      expect(stateOf(db)).toBe("done");
      expect(scheduleSessionBackfill(db)).toBe(false);
    } finally { vi.useRealTimers(); resetSessionBackfillState(); }
  });
});
