import { describe, it, expect } from "vitest";
import {
  parseTraceHeaders,
  takeTraceHeaders,
  traceOf,
  classifyAttempt,
  recordComboAttempt,
  comboAttemptsOf,
  COMBO_ATTEMPTS_MAX,
} from "../../open-sse/utils/traceMeta.js";

describe("trace headers", () => {
  it("returns null when no trace headers are present", () => {
    expect(parseTraceHeaders({ "content-type": "application/json" })).toBeNull();
    expect(parseTraceHeaders(null)).toBeNull();
  });

  it("trims, strips control chars and caps lengths", () => {
    const trace = parseTraceHeaders({
      "x-9r-trace": `  run\u0007-1 ${"a".repeat(300)}`,
      "x-9r-tags": " one , two\u0000 ,one,, " + Array.from({ length: 20 }, (_, i) => `t${i}`).join(","),
    });
    expect(trace.name.startsWith("run-1 ")).toBe(true);
    expect(trace.name.length).toBeLessThanOrEqual(128);
    expect(trace.tags[0]).toBe("one");
    expect(trace.tags[1]).toBe("two");
    expect(new Set(trace.tags).size).toBe(trace.tags.length);
    expect(trace.tags.length).toBe(10);
  });

  it("caps each tag at 32 characters", () => {
    const trace = parseTraceHeaders({ "x-9r-tags": "x".repeat(100) });
    expect(trace.name).toBeNull();
    expect(trace.tags).toEqual(["x".repeat(32)]);
  });

  it("reads headers case-insensitively", () => {
    expect(parseTraceHeaders({ "X-9R-Trace": "abc" })).toEqual({ name: "abc", tags: [] });
  });

  it("removes the headers from the raw request so they never go upstream", () => {
    const req = { headers: { "X-9R-Trace": "abc", "x-9r-tags": "a,b", authorization: "keep" } };
    const trace = takeTraceHeaders(req);
    expect(trace).toEqual({ name: "abc", tags: ["a", "b"] });
    expect(Object.keys(req.headers)).toEqual(["authorization"]);
    expect(traceOf(req)).toEqual(trace);
  });
});

describe("combo attempts", () => {
  it("classifies failure reasons", () => {
    expect(classifyAttempt(429)).toBe("rate_limit");
    expect(classifyAttempt(504)).toBe("timeout");
    expect(classifyAttempt(500, "ETIMEDOUT")).toBe("timeout");
    expect(classifyAttempt(200, "", true)).toBe("empty");
    expect(classifyAttempt(500)).toBe("error");
  });

  it("keeps at most the cap and sanitises fields", () => {
    const req = {};
    for (let i = 0; i < COMBO_ATTEMPTS_MAX + 5; i++) {
      recordComboAttempt(req, { model: `p/m${i}`, status: i === 0 ? 9999 : 429, reason: i === 1 ? "bogus" : "rate_limit" });
    }
    const list = comboAttemptsOf(req);
    expect(list.length).toBe(COMBO_ATTEMPTS_MAX);
    expect(list[0].status).toBeNull();
    expect(list[1].reason).toBe("error");
    expect(comboAttemptsOf({})).toBeNull();
  });

  it("never throws on bad input", () => {
    expect(() => recordComboAttempt(null, { model: "x" })).not.toThrow();
    expect(takeTraceHeaders(null)).toBeNull();
  });
});
