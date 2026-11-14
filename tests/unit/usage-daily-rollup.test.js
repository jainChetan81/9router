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
