import { afterEach, describe, expect, it } from "vitest";
import { register, snapshot, unregister } from "../../src/lib/agents/liveRegistry.js";
import { getLive } from "../../src/lib/agents/queries.js";
import { resetSessionColumnCache } from "../../src/lib/agents/dbColumns.js";
import { sessionKey } from "../../src/lib/agents/sessionKey.js";

const rawSession = "claude:550e8400-e29b-41d4-a716-446655440000";

afterEach(() => {
  for (const requests of Object.values(snapshot())) {
    for (const request of requests) unregister(request.reqId);
  }
  resetSessionColumnCache();
});

describe("agents live request wiring", () => {
  it.each([
    ["success", "ok"],
    ["failure", "error"],
    ["abort", "aborted"],
    ["early failure", "error"],
  ])("removes a registered request after %s", (_label, outcome) => {
    const reqId = `live-${outcome}-${Math.random()}`;
    expect(register(reqId, { session: rawSession, combo: "assistant", model: "openai/gpt-4o" })).toBe(true);
    expect(snapshot()[sessionKey(rawSession)]).toHaveLength(1);
    expect(unregister(reqId, outcome)).toBe(true);
    expect(snapshot()[sessionKey(rawSession)]).toBeUndefined();
  });

  it("merges in-flight requests into live sessions without completed SQL rows", async () => {
    const reqId = `live-query-${Math.random()}`;
    register(reqId, {
      session: rawSession,
      combo: "assistant",
      model: "openai/gpt-4o",
      provider: "openai",
      startedAt: performance.now(),
    });
    const db = {
      driver: "sql.js",
      all(sql) {
        if (sql === "PRAGMA table_info(usageHistory)") return [{ name: "session" }];
        return [];
      },
    };

    const result = await getLive(db, Date.now());
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      session: sessionKey(rawSession),
      inFlight: 1,
      lastActivityMs: expect.any(Number),
      pulsing: true,
      // In-flight requests are reported in inFlight, never in the completed rate.
      reqPerMin: 0,
    });
    expect(result.sessions[0].roles).toEqual([
      expect.objectContaining({
        role: "assistant", model: "openai/gpt-4o", inFlight: 1, pulsing: true,
        state: "thinking", idleSeconds: 0, lastActivityMs: expect.any(Number), tps: null, p50Ms: null,
      }),
    ]);
  });

  it("adds in-flight model and pulse data to a completed live session", async () => {
    const reqId = `live-existing-${Math.random()}`;
    register(reqId, { session: rawSession, combo: "assistant", model: "openai/current", provider: "openai" });
    const session = sessionKey(rawSession);
    const oldTs = new Date(Date.now() - 20_000).toISOString();
    const db = {
      driver: "sql.js",
      all(sql) {
        if (sql === "PRAGMA table_info(usageHistory)") return [{ name: "session" }];
        // One pass over the live window: one row per completed request.
        if (sql.includes("FROM usageHistory") && sql.includes("ORDER BY timestamp DESC")) {
          const row = { sess: session, timestamp: oldTs, role: "assistant", model: "openai/previous", ok: 1, ua: "Claude Code", hasLatency: 0, totalMs: null, ttftMs: null, stream: null, completionTokens: 0 };
          return [row, { ...row }];
        }
        return [];
      },
    };

    const result = await getLive(db, Date.now());
    // 2 completed requests in 5 minutes = 0.4/min; the running one is not mixed in.
    expect(result.sessions[0]).toMatchObject({ session, inFlight: 1, pulsing: true, reqPerMin: 0.4 });
    expect(result.sessions[0].roles[0]).toMatchObject({
      role: "assistant",
      model: "openai/current",
      requests: 2,
      inFlight: 1,
      pulsing: true,
    });
  });

  it("reads the live window with a single SQL pass and groups it in JS", async () => {
    const a = "aaaaaaaaaaaa", b = "bbbbbbbbbbbb";
    const now = Date.now();
    const ts = (agoMs) => new Date(now - agoMs).toISOString();
    const base = { ok: 1, ua: "claude-cli/2.1", hasLatency: 1, ttftMs: 1000, stream: 1, completionTokens: 100 };
    let liveQueries = 0;
    const db = {
      driver: "sql.js",
      all(sql) {
        if (sql === "PRAGMA table_info(usageHistory)") return [{ name: "session" }];
        liveQueries++;
        // Newest first, as the query orders them.
        return [
          { ...base, sess: a, timestamp: ts(1000), role: "implementer", model: "m-new", totalMs: 3000 },
          { ...base, sess: b, timestamp: ts(2000), role: "direct", model: "m-b", totalMs: 2000, ok: 0 },
          { ...base, sess: a, timestamp: ts(3000), role: "implementer", model: "m-old", totalMs: 5000 },
          { ...base, sess: a, timestamp: ts(4000), role: "scout", model: "m-scout", hasLatency: 0, totalMs: null, ttftMs: null },
        ];
      },
    };
    const result = await getLive(db, now);
    expect(liveQueries).toBe(1);
    expect(result.sessions.map((s) => s.session)).toEqual([a, b]);
    const first = result.sessions[0];
    expect(first).toMatchObject({ reqPerMin: 3 / 5, successRate: 1, p50TotalMs: 3000, inFlight: 0 });
    // The newest row of a role names its model.
    expect(first.roles.find((r) => r.role === "implementer")).toMatchObject({ model: "m-new", requests: 2, p50Ms: 3000 });
    expect(first.roles.find((r) => r.role === "scout")).toMatchObject({ model: "m-scout", requests: 1, p50Ms: null });
    expect(result.sessions[1]).toMatchObject({ reqPerMin: 1 / 5, successRate: 0 });
    expect(result.sampled.rows).toBe(4);
  });
});
