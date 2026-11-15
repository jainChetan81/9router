// ETag / 304 on the Agents GET routes: an unchanged live version is answered
// before the database is touched.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = { calls: 0, adapters: 0 };
const fakeDb = {
  driver: "sql.js",
  all(text) {
    sql.calls++;
    if (text === "PRAGMA table_info(usageHistory)") return [{ name: "session" }];
    return [];
  },
  get() { sql.calls++; return undefined; },
};

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => { sql.adapters++; return fakeDb; },
}));

const { bump } = await import("@/lib/live/bus.js");
const { cacheClear } = await import("@/lib/agents/cache.js");
const { resetFirstMsCache } = await import("@/lib/agents/range.js");
const live = await import("@/app/api/agents/live/route.js");
const sessions = await import("@/app/api/agents/sessions/route.js");
const analytics = await import("@/app/api/agents/analytics/route.js");
const tools = await import("@/app/api/agents/tools/route.js");

const get = (route, url, etag) => route.GET(new Request(`http://localhost${url}`, etag ? { headers: { "If-None-Match": etag } } : undefined));
const reset = () => { sql.calls = 0; sql.adapters = 0; };

beforeEach(() => { cacheClear(); resetFirstMsCache(); reset(); });

describe("agents routes ETag", () => {
  it("answers /live 304 with no SQL while the live version is unchanged", async () => {
    const first = await get(live, "/api/agents/live");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);
    expect(await first.json()).toMatchObject({ sessions: [] });
    expect(sql.calls).toBeGreaterThan(0);

    reset();
    for (let i = 0; i < 5; i++) {
      const again = await get(live, "/api/agents/live", etag);
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(await again.text()).toBe("");
    }
    expect(sql).toEqual({ calls: 0, adapters: 0 });
  });

  it("answers 200 again after an agents or usage bump", async () => {
    const etag = (await get(live, "/api/agents/live")).headers.get("etag");
    bump("agents");
    const afterAgents = await get(live, "/api/agents/live", etag);
    expect(afterAgents.status).toBe(200);
    const etag2 = afterAgents.headers.get("etag");
    expect(etag2).not.toBe(etag);
    expect((await get(live, "/api/agents/live", etag2)).status).toBe(304);
    bump("usage");
    expect((await get(live, "/api/agents/live", etag2)).status).toBe(200);
  });

  it.each([
    ["sessions", sessions, "/api/agents/sessions?preset=7D"],
    ["analytics", analytics, "/api/agents/analytics?preset=7D"],
    ["tools", tools, "/api/agents/tools?preset=7D"],
  ])("answers /%s 304 with no SQL and no adapter while unchanged", async (_name, route, url) => {
    const first = await get(route, url);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(sql.calls).toBeGreaterThan(0);

    reset();
    expect((await get(route, url, etag)).status).toBe(304);
    expect(sql).toEqual({ calls: 0, adapters: 0 });

    // Another range is another answer.
    expect((await get(route, url.replace("7D", "30D"), etag)).status).toBe(200);

    // A bump inside the short reuse window (5 s sessions, 30 s analytics and
    // tools) still returns the stored answer under its old ETag...
    bump("usage");
    reset();
    const reused = await get(route, url, etag);
    expect(reused.status).toBe(200);
    expect(reused.headers.get("etag")).toBe(etag);
    expect(sql.calls).toBe(0);

    // ...and after the window the answer is computed again under a new ETag.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      reset();
      const fresh = await get(route, url, etag);
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("etag")).not.toBe(etag);
      expect(sql.calls).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it("never puts request text into the ETag header", async () => {
    const res = await get(sessions, "/api/agents/sessions?preset=7D&cursor=" + encodeURIComponent('x"\r\nSet-Cookie: a=b'));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f.]+"$/);
  });

  it("a floor-window answer after a bump keeps its old ETag and asks for one trailing refetch", async () => {
    // First answer with no client ETag: stored under the current version.
    const first = await get(sessions, "/api/agents/sessions?preset=7D");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-9r-retry-after-ms")).toBe(null);

    // A bump inside the floor window: the stale body is served under its old
    // ETag, so the client's If-None-Match will no longer match it, and the
    // route names the remaining floor time for one trailing refetch.
    bump("usage");
    const reused = await get(sessions, "/api/agents/sessions?preset=7D");
    expect(reused.status).toBe(200);
    expect(reused.headers.get("etag")).toBe(first.headers.get("etag"));
    const retryAfter = parseInt(reused.headers.get("x-9r-retry-after-ms"), 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(5000);

    // The old ETag no longer answers 304 (the client must refetch), and after
    // the window the answer is computed fresh under the current ETag with no
    // retry marker.
    expect((await get(sessions, "/api/agents/sessions?preset=7D", first.headers.get("etag"))).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const fresh = await get(sessions, "/api/agents/sessions?preset=7D");
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("etag")).not.toBe(first.headers.get("etag"));
      expect(fresh.headers.get("x-9r-retry-after-ms")).toBe(null);
    } finally { vi.useRealTimers(); }
  });

  it("reads the oldest row at most once for the All preset", async () => {
    let minReads = 0;
    const original = fakeDb.get;
    fakeDb.get = (text) => { if (text.includes("MIN(timestamp)")) minReads++; return original(text); };
    try {
      for (const route of [sessions, analytics, tools]) await get(route, `/api/agents/${route === sessions ? "sessions" : route === analytics ? "analytics" : "tools"}?preset=All`);
      expect(minReads).toBe(1);
    } finally { fakeDb.get = original; }
  });
  it("a sync request skips the 304, the stored result and the floor", async () => {
    const url = "/api/agents/analytics?preset=7D";
    const sync = (etag) => analytics.GET(new Request(`http://localhost${url}`, { headers: { "x-9r-sync": "1", ...(etag && { "If-None-Match": etag }) } }));
    const first = await get(analytics, url);
    const etag = first.headers.get("etag");
    const calls = sql.calls;
    expect(calls).toBeGreaterThan(0);

    // Header absent: 304 from the tag, and the stored result without the tag. No SQL either way.
    expect((await get(analytics, url, etag)).status).toBe(304);
    expect((await get(analytics, url)).status).toBe(200);
    expect(sql.calls).toBe(calls);

    // Header present: a full answer, computed again, even with a matching tag.
    const fresh = await sync(etag);
    expect(fresh.status).toBe(200);
    expect(sql.calls).toBeGreaterThan(calls);

    // Inside the floor window after a bump: a plain request reuses the stored
    // body and asks for a trailing refetch; a sync request computes now.
    bump("usage");
    const reused = await get(analytics, url);
    expect(reused.headers.get("x-9r-retry-after-ms")).not.toBeNull();
    const again = sql.calls;
    const synced = await sync();
    expect(synced.status).toBe(200);
    expect(synced.headers.get("x-9r-retry-after-ms")).toBeNull();
    expect(sql.calls).toBeGreaterThan(again);
  });

  it("a sync request to /live is computed again under the same version", async () => {
    const first = await get(live, "/api/agents/live");
    const etag = first.headers.get("etag");
    expect((await get(live, "/api/agents/live", etag)).status).toBe(304);
    const calls = sql.calls;
    const synced = await live.GET(new Request("http://localhost/api/agents/live", { headers: { "x-9r-sync": "1", "If-None-Match": etag } }));
    expect(synced.status).toBe(200);
    expect(await synced.json()).toHaveProperty("sessions");
    expect(sql.calls).toBeGreaterThan(calls);
  });
});
