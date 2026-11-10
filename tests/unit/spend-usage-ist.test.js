import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let sqliteDb;
let driver;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ist-test-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  driver = await import("@/lib/db/driver.js");
  sqliteDb = await import("@/lib/db/index.js");
  await sqliteDb.initDb();
}, 90_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  try { await driver?.closeDb?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usageRepo IST bucketing (B12)", () => {
  it("buckets usageDaily by IST midnight (18:30 UTC) and matches chart/stats windows", async () => {
    const adapter = await driver.getAdapter();

    // 23:59:00 IST on Nov 9 -> IST dateKey 2026-11-09
    await sqliteDb.saveRequestUsage({
      timestamp: "2026-11-09T18:29:00.000Z",
      provider: "openai",
      model: "gpt-nov9",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      status: "ok",
    });

    // 00:05:00 IST on Nov 10 (still Nov 9 in UTC!) -> IST dateKey 2026-11-10
    await sqliteDb.saveRequestUsage({
      timestamp: "2026-11-09T18:35:00.000Z",
      provider: "openai",
      model: "gpt-nov10",
      tokens: { prompt_tokens: 200, completion_tokens: 50 },
      status: "ok",
    });

    // 6 IST days before Nov 10 = Nov 4 IST (early morning 00:30 IST = 19:00 UTC Nov 3)
    await sqliteDb.saveRequestUsage({
      timestamp: "2026-11-03T19:00:00.000Z",
      provider: "openai",
      model: "gpt-nov4",
      tokens: { prompt_tokens: 300, completion_tokens: 40 },
      status: "ok",
    });

    const dailyRows = adapter.all(`SELECT dateKey FROM usageDaily ORDER BY dateKey ASC`);
    expect(dailyRows.map((r) => r.dateKey)).toEqual(["2026-11-04", "2026-11-09", "2026-11-10"]);

    // Pin current time to 02:30 IST on Nov 10 (21:00 UTC on Nov 9 — still Nov 9 in UTC!).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T21:00:00.000Z"));

    const todayChart = await sqliteDb.getChartData("today");
    expect(todayChart).toHaveLength(24);
    expect(todayChart[0].label).toBe("00:00");
    expect(todayChart[0].requests).toBe(1);
    expect(todayChart[0].tokens).toBe(250);
    expect(todayChart.reduce((s, b) => s + b.requests, 0)).toBe(1); // excludes 18:29Z (Nov 9 IST)

    const todayStats = await sqliteDb.getUsageStats("today");
    expect(todayStats.totalRequests).toBe(1);
    expect(todayStats.totalPromptTokens).toBe(200);

    const chart7d = await sqliteDb.getChartData("7d");
    expect(chart7d).toHaveLength(7);
    expect(chart7d[0].label).toBe("Nov 4");
    expect(chart7d[0].requests).toBe(1);
    expect(chart7d[5].label).toBe("Nov 9");
    expect(chart7d[5].requests).toBe(1);
    expect(chart7d[6].label).toBe("Nov 10");
    expect(chart7d[6].requests).toBe(1);

    const stats7d = await sqliteDb.getUsageStats("7d");
    expect(stats7d.totalRequests).toBe(3);

    const chartAll = await sqliteDb.getChartData("all");
    expect(chartAll[0].label).toBe("Nov 4");
    expect(chartAll[chartAll.length - 1].label).toBe("Nov 10");

    const chart24h = await sqliteDb.getChartData("24h");
    expect(chart24h).toHaveLength(24);
    expect(chart24h.every((b) => /^\d{2}:\d{2}$/.test(b.label) && !b.label.startsWith("24:"))).toBe(true);
    expect(chart24h.reduce((s, b) => s + b.requests, 0)).toBe(2); // Nov 9 23:59 IST + Nov 10 00:05 IST
  }, 20_000);
});
