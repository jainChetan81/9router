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

  it("reads the oldest row at most once for the All preset", async () => {
    let minReads = 0;
    const original = fakeDb.get;
    fakeDb.get = (text) => { if (text.includes("MIN(timestamp)")) minReads++; return original(text); };
    try {
      for (const route of [sessions, analytics, tools]) await get(route, `/api/agents/${route === sessions ? "sessions" : route === analytics ? "analytics" : "tools"}?preset=All`);
      expect(minReads).toBe(1);
    } finally { fakeDb.get = original; }
  });
});
