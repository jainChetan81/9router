import { describe, it, expect, beforeEach } from "vitest";
import { cacheGet, cacheSet, cacheInvalidate, isFresh, updatedAgo, _test } from "../../src/lib/clientCache.js";

describe("clientCache", () => {
  beforeEach(() => _test.reset());

  it("stores and returns data with its time", () => {
    cacheSet("/api/spend?a", { x: 1 }, 1000);
    expect(cacheGet("/api/spend?a")).toEqual({ data: { x: 1 }, at: 1000 });
    expect(cacheGet("/api/missing")).toBeNull();
  });

  it("checks freshness against a TTL", () => {
    expect(isFresh({ at: 1000 }, 500, 1400)).toBe(true);
    expect(isFresh({ at: 1000 }, 500, 1600)).toBe(false);
    expect(isFresh(null, 500, 1000)).toBe(false);
  });

  it("invalidates by prefix only", () => {
    cacheSet("/api/spend?a", 1); cacheSet("/api/spend/quota", 2); cacheSet("/api/agents/x", 3);
    cacheInvalidate("/api/spend");
    expect(cacheGet("/api/spend?a")).toBeNull();
    expect(cacheGet("/api/spend/quota")).toBeNull();
    expect(cacheGet("/api/agents/x")?.data).toBe(3);
  });

  it("drops the oldest entry past the size bound", () => {
    for (let i = 0; i <= _test.MAX_ENTRIES; i++) cacheSet(`k${i}`, i);
    expect(_test.size()).toBe(_test.MAX_ENTRIES);
    expect(cacheGet("k0")).toBeNull();
    expect(cacheGet(`k${_test.MAX_ENTRIES}`)?.data).toBe(_test.MAX_ENTRIES);
  });

  it("formats the age label", () => {
    expect(updatedAgo(0)).toBe("");
    expect(updatedAgo(1000, 31_000)).toBe("Updated just now");
    expect(updatedAgo(0 + 1, 4 * 60_000 + 1)).toBe("Updated 4 min ago");
    expect(updatedAgo(1, 2 * 3600_000 + 1)).toBe("Updated 2 h ago");
  });
});
