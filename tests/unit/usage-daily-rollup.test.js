import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-rollup-"));
process.env.DATA_DIR = tempDataDir;

let db;
let usageRepo;
let adapterSync;
const previousDataDir = process.env.DATA_DIR;

const TODAY_KEY = (() => {
  // Day key is IST-based (see src/lib/spend/time.js), not browser-local.
  const d = new Date(Date.now() + 5.5 * 3600e3);
  return d.toISOString().slice(0, 10);
})();

function entry(i) {
  return {
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: { prompt_tokens: 10 + i, completion_tokens: 20 + i, cached_tokens: i },
    status: "ok",
  };
}

async function readStats() {
  // getUsageStats reads usageDaily and must see the unflushed in-memory delta.
  return await usageRepo.getUsageStats("today");
}

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  adapterSync = (await import("@/lib/db/driver.js")).getAdapterSync;
  await db.initDb();
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
});

afterAll(async () => {
  process.env.DATA_DIR = previousDataDir;
});

describe("usageDaily rollup buffering", () => {
  it("keeps totals exact before and after the flush", async () => {
    const N = 5;
    for (let i = 0; i < N; i++) {
      await db.saveRequestUsage(entry(i));
    }

    // Delta is still unflushed in memory (flush timer is ~2 s out).
    const statsBefore = await readStats();
    const persistedRowBefore = adapterSync()
      .get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [TODAY_KEY]);
    const persistedBefore = persistedRowBefore ? JSON.parse(persistedRowBefore.data) : { requests: 0 };

    expect(statsBefore.byProvider["openai"].requests).toBe(N);
    expect(statsBefore.byProvider["openai"].promptTokens).toBe(10 + 11 + 12 + 13 + 14);
    expect(statsBefore.byProvider["openai"].completionTokens).toBe(20 + 21 + 22 + 23 + 24);
    expect(statsBefore.totalRequests).toBe(N);

    // Wait past the ~2 s flush so the buffer hits the DB.
    await new Promise((r) => setTimeout(r, 2300));
    expect(usageRepo.globalFlushBuffer().size).toBe(0);

    const rowAfter = adapterSync()
      .get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [TODAY_KEY]);
    const persistedAfter = JSON.parse(rowAfter.data);
    expect(persistedAfter.requests).toBe(persistedBefore.requests + N);
    expect(persistedAfter.promptTokens).toBe((persistedBefore.promptTokens || 0) + 10 + 11 + 12 + 13 + 14);
    expect(persistedAfter.completionTokens).toBe((persistedBefore.completionTokens || 0) + 20 + 21 + 22 + 23 + 24);

    const statsAfter = await readStats();
    expect(statsAfter.byProvider["openai"].requests).toBe(statsBefore.byProvider["openai"].requests);
    expect(statsAfter.byProvider["openai"].promptTokens).toBe(statsBefore.byProvider["openai"].promptTokens);
    expect(statsAfter.byProvider["openai"].completionTokens).toBe(statsBefore.byProvider["openai"].completionTokens);
    // History INSERT is synchronous — every row is queryable immediately.
    expect(
      adapterSync().get(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp >= ?`, [
        new Date(Date.now() - 10000).toISOString(),
      ]).n
    ).toBeGreaterThanOrEqual(N);
  });

  it("merges unflushed deltas into multi-group day stats", async () => {
    await db.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "cc",
      model: "claude-opus-5-5",
      connectionId: "conn-xyz",
      apiKey: "test-api-key-1234567890",
      tokens: { prompt_tokens: 5, completion_tokens: 7 },
      status: "ok",
    });

    const stats = await readStats();
    expect(stats.byProvider["cc"].requests).toBe(1);
    expect(stats.byModel["claude-opus-5-5 (cc)"].requests).toBe(1);
    expect(stats.byAccount[Object.keys(stats.byAccount)[0]].requests).toBe(1);
    expect(stats.byApiKey[Object.keys(stats.byApiKey)[0]].promptTokens).toBe(5);

    // Wait for flush and confirm persisted totals match.
    await new Promise((r) => setTimeout(r, 2300));
    expect(usageRepo.globalFlushBuffer().size).toBe(0);
    const row = adapterSync().get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [TODAY_KEY]);
    const persisted = JSON.parse(row.data);
    expect(persisted.byProvider["cc"].requests).toBe(1);
    expect(persisted.byProvider["openai"].requests).toBe(5);
  });

  it("flushes the remaining buffer at shutdown", async () => {
    // Queue a fresh entry and do NOT wait for the timer.
    await db.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      tokens: { prompt_tokens: 3, completion_tokens: 4 },
      status: "ok",
    });
    expect(usageRepo.globalFlushBuffer().size).toBeGreaterThan(0);

    usageRepo.runShutdownFlush();
    expect(usageRepo.globalFlushBuffer().size).toBe(0);

    const row = adapterSync().get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [TODAY_KEY]);
    const persisted = JSON.parse(row.data);
    expect(persisted.byProvider["anthropic"].requests).toBe(1);
    expect(persisted.byProvider["anthropic"].promptTokens).toBe(3);
  });
});

describe("usageDaily crash reconcile", () => {
  const save = (provider, p, c) => db.saveRequestUsage({
    timestamp: new Date().toISOString(),
    provider,
    model: "m1",
    tokens: { prompt_tokens: p, completion_tokens: c },
    status: "ok",
  });
  const today = () => JSON.parse(adapterSync().get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [TODAY_KEY])?.data || "{}");
  const maxId = () => Number(adapterSync().get(`SELECT MAX(id) AS m FROM usageHistory`).m) || 0;
  const marker = () => adapterSync().get(`SELECT value FROM _meta WHERE key = 'usageDailyFlushedMaxId'`);
  const newProcess = () => {
    global._usageDailyReconciled = false;
    global._usageFirstSavedId = null;
  };

  it("seeds the marker on first start and folds nothing", async () => {
    await save("seed-test", 1, 1);
    usageRepo.runShutdownFlush();
    adapterSync().run(`DELETE FROM _meta WHERE key = 'usageDailyFlushedMaxId'`);
    const before = today().byProvider?.["seed-test"]?.requests;
    newProcess();
    await usageRepo.reconcileUsageDaily();
    expect(Number(marker().value)).toBe(maxId());
    expect(today().byProvider["seed-test"].requests).toBe(before);
  });

  it("rebuilds rows lost in a crash, exactly once", async () => {
    usageRepo.runShutdownFlush();
    await save("crash-test", 11, 22);
    await save("crash-test", 5, 6);
    // The crash: the buffer is gone and the marker is from before the rows.
    usageRepo.globalFlushBuffer().clear();
    expect(today().byProvider["crash-test"]).toBeUndefined();

    newProcess();
    await usageRepo.reconcileUsageDaily();
    expect(today().byProvider["crash-test"].requests).toBe(2);
    expect(today().byProvider["crash-test"].promptTokens).toBe(16);
    expect(today().byProvider["crash-test"].completionTokens).toBe(28);
    expect(Number(marker().value)).toBe(maxId());

    newProcess();
    await usageRepo.reconcileUsageDaily();
    expect(today().byProvider["crash-test"].requests).toBe(2);
  });

  it("skips rows this process saved, which the buffer still holds", async () => {
    usageRepo.runShutdownFlush();
    newProcess();
    await save("live-test", 2, 3);
    // Reconcile runs after the first save of this process.
    await usageRepo.reconcileUsageDaily();
    usageRepo.runShutdownFlush();
    expect(today().byProvider["live-test"].requests).toBe(1);
  });
  it("folds the lost tail when a flush runs before the bootstrap reconcile", async () => {
    usageRepo.runShutdownFlush();
    await save("crash-flush-test", 7, 8);
    await save("crash-flush-test", 1, 2);
    // The crash: the buffer is gone, the marker is from before the rows.
    usageRepo.globalFlushBuffer().clear();

    // New process: /v1 traffic saves and flushes before any page render.
    newProcess();
    await save("after-crash", 4, 4);
    await usageRepo.flushUsageDaily();
    expect(today().byProvider["crash-flush-test"].requests).toBe(2);
    expect(today().byProvider["crash-flush-test"].promptTokens).toBe(8);
    expect(today().byProvider["after-crash"].requests).toBe(1);
    expect(Number(marker().value)).toBe(maxId());

    // The bootstrap call afterwards is a no-op.
    await usageRepo.reconcileUsageDaily();
    expect(today().byProvider["crash-flush-test"].requests).toBe(2);
    expect(today().byProvider["after-crash"].requests).toBe(1);
  });

  it("folds the lost tail before the first daily read", async () => {
    usageRepo.runShutdownFlush();
    await save("crash-read-test", 3, 3);
    usageRepo.globalFlushBuffer().clear();
    newProcess();
    const stats = await usageRepo.getUsageStats("today");
    expect(stats.byProvider["crash-read-test"].requests).toBe(1);
  });
});

describe("usageDaily reconcile per-day guard", () => {
  const DAY = 86400e3;
  const dayKey = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
  const saveAt = (ms, provider) => db.saveRequestUsage({
    timestamp: new Date(ms).toISOString(),
    provider,
    model: "m1",
    tokens: { prompt_tokens: 1, completion_tokens: 1 },
    status: "ok",
  });
  const day = (key) => JSON.parse(adapterSync().get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [key])?.data || "{}");
  const maxId = () => Number(adapterSync().get(`SELECT MAX(id) AS m FROM usageHistory`).m) || 0;
  const setMarker = (id) => adapterSync().run(`UPDATE _meta SET value = ? WHERE key = 'usageDailyFlushedMaxId'`, [String(id)]);
  const marker = () => Number(adapterSync().get(`SELECT value FROM _meta WHERE key = 'usageDailyFlushedMaxId'`).value);
  const newProcess = () => {
    global._usageDailyReconciled = false;
    global._usageFirstSavedId = null;
  };

  it("skips a day an older build already counted (rollback then forward)", async () => {
    const at = Date.now() - 3 * DAY;
    usageRepo.runShutdownFlush();
    const before = maxId();
    await saveAt(at, "rollback-test");
    await saveAt(at + 1000, "rollback-test");
    // The old build wrote usageDaily on every save and left the marker behind.
    usageRepo.runShutdownFlush();
    setMarker(before);

    newProcess();
    await usageRepo.reconcileUsageDaily();
    expect(day(dayKey(at)).requests).toBe(2);
    expect(day(dayKey(at)).byProvider["rollback-test"].requests).toBe(2);
    expect(marker()).toBe(maxId());
  });

  it("folds a day that is missing exactly the tail", async () => {
    const at = Date.now() - 4 * DAY;
    await saveAt(at, "exact-test");
    usageRepo.runShutdownFlush();
    await saveAt(at + 1000, "exact-test");
    await saveAt(at + 2000, "exact-test");
    usageRepo.globalFlushBuffer().clear();

    newProcess();
    await usageRepo.reconcileUsageDaily();
    expect(day(dayKey(at)).requests).toBe(3);
    expect(day(dayKey(at)).byProvider["exact-test"].requests).toBe(3);
    expect(marker()).toBe(maxId());
  });

  it("warns and skips a day whose counts do not line up", async () => {
    const at = Date.now() - 5 * DAY;
    const key = dayKey(at);
    await saveAt(at, "mismatch-test");
    usageRepo.runShutdownFlush();
    // Two rows lost in a crash, and one of them already counted by another build.
    await saveAt(at + 1000, "mismatch-test");
    await saveAt(at + 2000, "mismatch-test");
    usageRepo.globalFlushBuffer().clear();
    const partial = day(key);
    partial.requests += 1;
    adapterSync().run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(partial), key]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    newProcess();
    await usageRepo.reconcileUsageDaily();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(key));
    warn.mockRestore();
    expect(day(key).requests).toBe(2);
    expect(day(key).byProvider["mismatch-test"].requests).toBe(1);
    // The marker still moves, so the day is not judged again.
    expect(marker()).toBe(maxId());
  });
});
