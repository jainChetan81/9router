import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
export const config = { testTimeout: 60000 };

// Opt-in: runs only when a copy of a real 9Router DB is available.
// AGENTS_SMOKE_DB=/path/to/copy.sqlite npx vitest run unit/agents-smoke-copy.test.js
const SMOKE_DB = process.env.AGENTS_SMOKE_DB || "/tmp/agents-db-copy.sqlite";
const HAS_DB = fs.existsSync(SMOKE_DB);
const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(() => {
  if (!HAS_DB) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-smoke-"));
  // copy live db copy into temp data dir as db/data.sqlite
  const dbDir = path.join(tempDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  fs.copyFileSync(SMOKE_DB, path.join(dbDir, "data.sqlite"));
  process.env.DATA_DIR = tempDir;
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe.skipIf(!HAS_DB)("agents smoke on db copy", { timeout: 60000 }, () => {
  it("listSessions 30D", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { listSessionsPage } = await import("@/lib/agents/queries.js");
    const { resolveRange } = await import("@/lib/agents/range.js");
    const { distinctFirstMs } = await import("@/lib/agents/queries.js");
    const now = Date.now();
    const firstMs = await distinctFirstMs(db);
    // use 30D relative to db max? range uses now (system clock 2026-11-09) which matches db max. ok.
    const range = resolveRange(new URLSearchParams("preset=30D"), now, firstMs);
    const t0 = Date.now();
    const page = await listSessionsPage(db, new Date(range.from).toISOString(), new Date(range.to).toISOString(), { limit: 100 });
    console.log("30D sessions page:", page.sessions.length, "total:", page.total, "ms:", Date.now() - t0);
    expect(page.sessions.length).toBeGreaterThan(0);
  });

  it("analytics 7D", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { getAnalytics } = await import("@/lib/agents/queries.js");
    const { resolveRange } = await import("@/lib/agents/range.js");
    const { distinctFirstMs } = await import("@/lib/agents/queries.js");
    const now = Date.now();
    const firstMs = await distinctFirstMs(db);
    const range = resolveRange(new URLSearchParams("preset=7D"), now, firstMs);
    const t0 = Date.now();
    const a = await getAnalytics(db, new Date(range.from).toISOString(), new Date(range.to).toISOString());
    console.log("7D analytics ms:", Date.now() - t0, "byRole:", a.byRole.length, "modelByRole:", a.modelByRole.length);
    expect(a.byRole.length).toBeGreaterThan(0);
  });

  it("analytics 30D", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { getAnalytics } = await import("@/lib/agents/queries.js");
    const { resolveRange } = await import("@/lib/agents/range.js");
    const { distinctFirstMs } = await import("@/lib/agents/queries.js");
    const now = Date.now();
    const firstMs = await distinctFirstMs(db);
    const range = resolveRange(new URLSearchParams("preset=30D"), now, firstMs);
    const t0 = Date.now();
    const a = await getAnalytics(db, new Date(range.from).toISOString(), new Date(range.to).toISOString());
    console.log("30D analytics ms:", Date.now() - t0, "byRole:", a.byRole.length, "modelByRole:", a.modelByRole.length);
    console.log("SAMPLE byRole[0]:", JSON.stringify(a.byRole[0]));
    console.log("SAMPLE modelByRole[0]:", JSON.stringify(a.modelByRole[0]));
    console.log("delegationRate:", a.delegationRate, "childrenPerSession:", a.childrenPerSession);
    expect(a.byRole.length).toBeGreaterThan(0);
  });

  it("live", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { getLive } = await import("@/lib/agents/queries.js");
    const t0 = Date.now();
    const l = await getLive(db, Date.now());
    console.log("live ms:", Date.now() - t0, "sessions:", l.sessions.length);
    expect(Array.isArray(l.sessions)).toBe(true);
  });

  it("busiest session detail", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { getSessionDetail } = await import("@/lib/agents/queries.js");
    const { hasSessionColumn, sessionSql } = await import("@/lib/agents/dbColumns.js");
    const sExpr = sessionSql(hasSessionColumn(db));
    const busiest = db.get(
      `SELECT ${sExpr} AS session, COUNT(*) AS requests
       FROM usageHistory
       WHERE ${sExpr} IS NOT NULL
       GROUP BY ${sExpr}
       ORDER BY requests DESC
       LIMIT 1`
    );
    expect(busiest?.session).toBeTruthy();
    const t0 = Date.now();
    const detail = await getSessionDetail(db, busiest.session);
    const requestCount = detail.agents.reduce((sum, lane) => sum + lane.requests.length, 0);
    console.log("busiest detail:", busiest.session, "source rows:", busiest.requests, "returned:", requestCount, "ms:", Date.now() - t0);
    expect(requestCount).toBeLessThanOrEqual(2000);
  });
});

function vi_reset() {}
