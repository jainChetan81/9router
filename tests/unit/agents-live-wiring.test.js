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
      reqPerMin: 0.2,
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
        if (sql.includes("GROUP BY sess") && sql.includes("ORDER BY lastTs")) {
          return [{ sess: session, lastTs: oldTs, ua: "Claude Code", requests: 2, oks: 2 }];
        }
        if (sql.includes("GROUP BY sess, role, model")) {
          return [{ sess: session, role: "assistant", model: "openai/previous", requests: 2, lastTs: oldTs }];
        }
        return [];
      },
    };

    const result = await getLive(db, Date.now());
    expect(result.sessions[0]).toMatchObject({ session, inFlight: 1, pulsing: true, reqPerMin: 0.6 });
    expect(result.sessions[0].roles[0]).toMatchObject({
      role: "assistant",
      model: "openai/current",
      requests: 2,
      inFlight: 1,
      pulsing: true,
    });
  });
});
