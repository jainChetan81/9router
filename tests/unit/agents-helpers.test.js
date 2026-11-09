import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-agents-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  // seed rows
  const now = Date.now();
  const mk = (i, session, combo, ua, status, latency) => ({
    timestamp: new Date(now - (1000 - i) * 60000).toISOString(),
    provider: "anthropic",
    model: combo === "claude-haiku-5-5" ? "claude-haiku-5-5" : "claude-opus-5-5",
    apiKey: "key1",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    cost: 0.01,
    status: status || "ok",
    endpoint: "/v1/chat",
    meta: { ua: ua || "claude-cli/2.1.318 (external, t3-code, agent-sdk/0.3.316)", session, combo, latency: latency || null },
  });
  // parent session (span wide enough to contain child)
  for (let i = 0; i < 5; i++) await db.saveRequestUsage(mk(i, "parent111111", "claude-opus-5-5", "claude-cli/2.1.318 (external, t3-code, agent-sdk/0.3.316)", "ok", { ttftMs: 100, totalMs: 500, stream: true }));
  await db.saveRequestUsage(mk(99, "parent111111", "claude-opus-5-5", "claude-cli/2.1.318 (external, t3-code, agent-sdk/0.3.316)", "ok", { ttftMs: 100, totalMs: 500, stream: true }));
  // implementer + scout in same session
  for (let i = 0; i < 3; i++) await db.saveRequestUsage(mk(10+i, "parent111111", "implementer", "claude-cli/2.1.318 (external, t3-code, agent-sdk/0.3.316)", "ok", { ttftMs: 50, totalMs: 200, stream: true }));
  for (let i = 0; i < 2; i++) await db.saveRequestUsage(mk(20+i, "parent111111", "scout", "claude-cli/2.1.318 (external, t3-code, agent-sdk/0.3.316)", "ok", { ttftMs: 30, totalMs: 120, stream: true }));
  // haiku background
  for (let i = 0; i < 4; i++) await db.saveRequestUsage(mk(30+i, "parent111111", "claude-haiku-5-5", "claude-cli/2.1.318 (external, t3-code, agent-sdk/0.3.316)", "ok", null));
  // T3 child session (different session, same apiKey)
  for (let i = 0; i < 6; i++) await db.saveRequestUsage(mk(40+i, "child22222222", "scout", "T3 Code/0.167.0 (Ubuntu 26.4.0; x86_64)", "ok", { ttftMs: 40, totalMs: 150, stream: true }));
  // old rows without latency/status (meta empty-ish) but with session
  await db.saveRequestUsage({ timestamp: new Date(now - 50*60000).toISOString(), provider: "openai", model: "gpt-4", apiKey: "key1", promptTokens: 1, completionTokens: 2, cost: 0.001, status: undefined, tokens: { prompt_tokens:1, completion_tokens:2 }, meta: { ua: "curl", session: "old33333333" } });
  // row without session
  await db.saveRequestUsage({ timestamp: new Date(now - 51*60000).toISOString(), provider: "openai", model: "gpt-4", apiKey: "key1", promptTokens: 1, completionTokens: 2, cost: 0.001, status: "ok", tokens: { prompt_tokens:1, completion_tokens:2 }, meta: { ua: "curl" } });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("agents helpers", () => {
  it("listSessions returns parent + child", async () => {
    const { listSessions } = await import("@/lib/agents/queries.js");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const from = new Date(Date.now() - 24*60*60*1000).toISOString();
    const to = new Date(Date.now() + 60000).toISOString();
    const sessions = await listSessions(adapter, from, to);
    const ids = sessions.map((s) => s.session);
    expect(ids).toContain("parent111111");
    expect(ids).toContain("child22222222");
    const parent = sessions.find((s) => s.session === "parent111111");
    expect(parent.client).toBe("Claude Code");
    expect(parent.roles.map((r) => r.role)).toContain("background");
    const child = sessions.find((s) => s.session === "child22222222");
    expect(child.parent).not.toBeNull();
    expect(child.parent.inferred).toBe(true);
  });

  it("listSessionsPage paginates in timestamp order", async () => {
    const { listSessionsPage } = await import("@/lib/agents/queries.js");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const from = new Date(Date.now() - 24*60*60*1000).toISOString();
    const to = new Date(Date.now() + 60000).toISOString();
    const first = await listSessionsPage(adapter, from, to, { limit: 1 });
    expect(first.sessions).toHaveLength(1);
    expect(first.nextCursor).toBe(first.sessions[0].session);
    const second = await listSessionsPage(adapter, from, to, { limit: 1, cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].session).not.toBe(first.sessions[0].session);
    expect(first.total).toBeGreaterThanOrEqual(2);

    let cursor = null;
    let child;
    for (let pageNum = 0; pageNum < first.total; pageNum++) {
      const page = await listSessionsPage(adapter, from, to, { limit: 1, cursor });
      child = page.sessions.find((session) => session.session === "child22222222") || child;
      if (child || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(child?.parent).toEqual({ session: "parent111111", inferred: true });
  });

  it("getSessionDetail returns agents with requests", async () => {
    const { getSessionDetail } = await import("@/lib/agents/queries.js");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const detail = await getSessionDetail(adapter, "parent111111");
    expect(detail.agents.length).toBeGreaterThan(0);
    expect(detail.children).toContainEqual({ session: "child22222222", inferred: true });
    const totalReqs = detail.agents.reduce((a, g) => a + g.requests.length, 0);
    expect(totalReqs).toBe(15);
    const firstReq = detail.agents[0].requests[0];
    expect(firstReq.ttftMs).not.toBe(0);
  });

  it("getAnalytics shape", async () => {
    const { getAnalytics } = await import("@/lib/agents/queries.js");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const from = new Date(Date.now() - 24*60*60*1000).toISOString();
    const to = new Date(Date.now() + 60000).toISOString();
    const a = await getAnalytics(adapter, from, to);
    expect(Array.isArray(a.byRole)).toBe(true);
    expect(typeof a.delegationRate).toBe("number");
    expect(a.childrenPerSession).toBeCloseTo(1 / 3);
    expect(Array.isArray(a.modelByRole)).toBe(true);
    const mb = a.modelByRole.find((x) => x.role === "scout");
    expect(mb).toBeDefined();
    expect(mb.ttftP50).not.toBe(0);
  });

  it("getAnalytics caps latency samples globally and reports the sample", async () => {
    const { getAnalytics, ANALYTICS_SAMPLE_CAP } = await import("@/lib/agents/queries.js");
    expect(ANALYTICS_SAMPLE_CAP).toBe(20000);
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60000).toISOString();
    const a = await getAnalytics(adapter, from, to);
    expect(a.sampled).toEqual({ rows: expect.any(Number), cap: ANALYTICS_SAMPLE_CAP });
    expect(a.sampled.rows).toBeLessThanOrEqual(ANALYTICS_SAMPLE_CAP);
    for (const m of a.modelByRole) expect(m.samples).toBeLessThanOrEqual(a.sampled.rows);
  });

  it("getLive returns sessions", async () => {
    const { getLive } = await import("@/lib/agents/queries.js");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const l = await getLive(adapter, Date.now());
    expect(Array.isArray(l.sessions)).toBe(true);
  });

  it("limits live results to 200 sessions", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const now = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 205; i++) {
      const session = `live${String(i).padStart(9, "0")}`;
      const meta = JSON.stringify({ session, combo: "scout", ua: "T3 Code/0.1" });
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, tokens, meta, session)
         VALUES(?, 'openai', 'gpt-test', 'live-key', 1, 1, 0, 'ok', '{}', ?, ?)`,
        [now, meta, session]
      );
    }
    const { getLive } = await import("@/lib/agents/queries.js");
    const live = await getLive(adapter, Date.now());
    expect(live.sessions).toHaveLength(200);
  });

  it("cache evicts expired entries and stays below 100 keys", async () => {
    const { cacheClear, cacheGet, cacheSet } = await import("@/lib/agents/cache.js");
    cacheClear();
    for (let i = 0; i < 99; i++) cacheSet(`live-${i}`, i, 10000);
    cacheSet("expired", "old", -1);
    cacheSet("fresh", "new", 10000);
    expect(cacheGet("live-0")).toBe(0);
    expect(cacheGet("expired")).toBeUndefined();

    cacheClear();
    for (let i = 0; i < 100; i++) cacheSet(`entry-${i}`, i, 10000);
    cacheGet("entry-0");
    cacheSet("entry-100", 100, 10000);
    expect(cacheGet("entry-0")).toBe(0);
    expect(cacheGet("entry-1")).toBeUndefined();
    expect(cacheGet("entry-100")).toBe(100);
    cacheClear();
  });
});
