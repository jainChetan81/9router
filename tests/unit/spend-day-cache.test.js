import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Closed-day cache: cached day slices must produce totals identical to an
// uncached whole-range aggregation on the same fixture data.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let sqliteDb;
let driver;
let aggregateSpend;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-spend-daycache-test-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  driver = await import("@/lib/db/driver.js");
  sqliteDb = await import("@/lib/db/index.js");
  await sqliteDb.initDb();
  ({ aggregateSpend } = await import("@/lib/spend/aggregate.js"));
}, 90_000);

afterAll(async () => {
  try { await driver?.closeDb?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
}, 60_000);

// Fixed "now": 21:00 UTC Nov 9 = 02:30 IST Nov 10. 30D spans Nov 11 IST .. Nov 10 IST.
const NOW = Date.parse("2026-11-09T21:00:00.000Z");
const TOK = { prompt_tokens: 100, completion_tokens: 20 };

describe("closed-day slice cache (WP3)", () => {
  it("returns identical totals for cached day slices and an uncached range", async () => {
    const rows = [];
    for (let i = 0; i < 12; i++) {
      // Spread over 12 IST days ending Nov 10, several sessions per day.
      for (let s = 0; s < 3; s++) {
        rows.push({
          t: new Date(Date.parse("2026-10-29T18:30:00.000Z") + i * 86400_000 + (s + 1) * 3600_000).toISOString(),
          provider: ["claude", "codex", "openrouter"][s],
          model: ["claude-x", "gpt-a", "or/m1"][s],
          key: "k1",
          tokens: TOK,
          meta: { ua: "T3 Code/1.0", session: `s${i}-${s}`, combo: s === 2 ? "c2" : "main", realCost: s === 2 ? 0.25 : undefined },
        });
      }
    }
    for (const r of rows) {
      await sqliteDb.saveRequestUsage({ ...r, status: "ok" });
    }
    const a = await driver.getAdapter();
    a.all(`SELECT id, model FROM usageHistory`).forEach(({ id, model }) => {
      if (model === "or/m1") a.run(`UPDATE usageHistory SET cost = 0.5 WHERE id = ?`, [id]);
    });
    const wrapped = {
      get: (sql, p = []) => a.get(sql, p),
      all: (sql, p = []) => a.all(sql, p),
    };

    const params = { preset: "Custom", from: "2026-10-29", to: "2026-11-09" };
    // Baseline: skipCache bypasses the body cache; no day slice is cached yet.
    const base = aggregateSpend(wrapped, { params: new URLSearchParams(params), now: NOW, skipCache: true });
    // Cached: warm run (day slices cached, body cache populated) then a later
    // run past the body TTL (day slices hit, only today recomputed).
    aggregateSpend(wrapped, { params: new URLSearchParams(params), now: NOW });
    const warm = aggregateSpend(wrapped, { params: new URLSearchParams(params), now: NOW + 31_000 });

    expect(warm.totals).toEqual(base.totals);
    expect(warm.bars.map((b) => [b.label, b.val, b.real, b.list])).toEqual(base.bars.map((b) => [b.label, b.val, b.real, b.list]));
    expect(warm.groups.key).toEqual(base.groups.key);
    expect(warm.groups.client).toEqual(base.groups.client);
    expect(warm.groups.role).toEqual(base.groups.role);
    expect(warm.clock).toEqual(base.clock);
    expect(warm.sessionCount).toBe(base.sessionCount);
    expect(warm.sessions.map((s) => [s.id, s.v, s.req])).toEqual(base.sessions.map((s) => [s.id, s.v, s.req]));
    // Outliers: per-day top lists re-ranked; values equal, order may differ on ties.
    const norm = (o) => ({ ...o, when: undefined });
    expect(warm.outliers.value.map(norm)).toEqual(base.outliers.value.map(norm));
  }, 60_000);
  it("a sync read recomputes today's slice; closed days stay cached", async () => {
    const a = await driver.getAdapter();
    const wrapped = { get: (sql, p = []) => a.get(sql, p), all: (sql, p = []) => a.all(sql, p) };
    const params = () => new URLSearchParams({ preset: "30D" });
    // One row today (IST Nov 10) and one on a closed day (IST Nov 5).
    const TODAY_TS = "2026-11-09T19:00:00.000Z", CLOSED_TS = "2026-11-05T10:00:00.000Z";
    for (const timestamp of [TODAY_TS, CLOSED_TS]) {
      await sqliteDb.saveRequestUsage({ timestamp, provider: "openrouter", model: "or/m1", apiKey: "k1", tokens: TOK, status: "ok", meta: { ua: "T3 Code/1.0" } });
    }
    const before = aggregateSpend(wrapped, { params: params(), now: NOW });

    // Change both rows. No row is added, so nothing else tells the caches
    // that the data moved.
    const todayRow = a.get(`SELECT id FROM usageHistory WHERE timestamp = ?`, [TODAY_TS]);
    const closedRow = a.get(`SELECT id FROM usageHistory WHERE timestamp = ?`, [CLOSED_TS]);
    a.run(`UPDATE usageHistory SET cost = cost + 5 WHERE id = ?`, [todayRow.id]);
    a.run(`UPDATE usageHistory SET cost = cost + 7 WHERE id = ?`, [closedRow.id]);

    // Without the sync signal: the cached answer.
    const cached = aggregateSpend(wrapped, { params: params(), now: NOW + 1000 });
    expect(cached.totals).toEqual(before.totals);

    // With it: today's change shows, the closed day's does not.
    const synced = aggregateSpend(wrapped, { params: params(), now: NOW + 1000, skipCache: true });
    expect(synced.totals.list).toBeCloseTo(before.totals.list + 5, 6);
  }, 60_000);
});
