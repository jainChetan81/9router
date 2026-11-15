// The Usage page asks for stats per period; only the latest request may set the state.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createLatestRequest } from "../../src/shared/utils/latestRequest.js";

// A fetch whose responses the test releases by hand.
function manualFetch() {
  const calls = [];
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    const call = { url, signal, respond: (body, ok = true) => resolve({ ok, json: async () => body }) };
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    calls.push(call);
  });
  return { calls, fetchImpl };
}

describe("latest request", () => {
  it("a late answer for an old period never counts, in either order", async () => {
    const { calls, fetchImpl } = manualFetch();
    const stats = createLatestRequest(fetchImpl);
    const today = stats.json("/api/usage/stats?period=today");
    const week = stats.json("/api/usage/stats?period=7d");
    expect(calls[0].signal.aborted).toBe(true); // the old request is aborted, not left running
    expect(calls[1].signal.aborted).toBe(false);
    calls[1].respond({ period: "7d" });
    expect(await week).toEqual({ current: true, data: { period: "7d" } });
    expect(await today).toEqual({ current: false, data: null });
  });

  it("a response that ignores the abort is still not current", async () => {
    const calls = [];
    const stats = createLatestRequest((url) => new Promise((resolve) => calls.push(() => resolve({ ok: true, json: async () => ({ url }) }))));
    const first = stats.json("a"), second = stats.json("b");
    calls[1](); calls[0](); // the old one answers last
    expect((await second).current).toBe(true);
    expect(await first).toMatchObject({ current: false });
  });

  it("an HTTP or network error gives no data but still ends the request", async () => {
    const { calls, fetchImpl } = manualFetch();
    const stats = createLatestRequest(fetchImpl);
    const failed = stats.json("x");
    calls[0].respond({}, false);
    expect(await failed).toEqual({ current: true, data: null });
    expect(await createLatestRequest(async () => { throw new Error("offline"); }).json("x")).toEqual({ current: true, data: null });
  });

  it("cancel aborts the request in flight", async () => {
    const { calls, fetchImpl } = manualFetch();
    const stats = createLatestRequest(fetchImpl);
    const pending = stats.json("x");
    stats.cancel();
    expect(calls[0].signal.aborted).toBe(true);
    expect((await pending).current).toBe(false);
  });
});

describe("UsageStats wiring", () => {
  const source = readFileSync(new URL("../../src/shared/components/UsageStats.js", import.meta.url), "utf8");
  const streamEffect = source.slice(source.indexOf('new EventSource("/api/usage/stream")'), source.indexOf("const fetchStatsRef"));

  it("the usage stream effect does not depend on the period", () => {
    expect(streamEffect).toMatch(/\}, \[\]\);/);
    expect(streamEffect).not.toMatch(/\[fetchStats\]/);
  });
  it("showing the tab fetches once: the live tick does it, not the visibility handler", () => {
    expect(streamEffect).not.toMatch(/fetchStats\(\)/);
    expect(source).toMatch(/fetchStatsRef\.current\(\)/);
  });
  it("stats go through the latest-request guard", () => {
    expect(source).toMatch(/statsRequest\.json\(`\/api\/usage\/stats\?period=\$\{period\}`\)/);
    expect(source).not.toMatch(/\bfetch\(`\/api\/usage\/stats/);
  });
});
