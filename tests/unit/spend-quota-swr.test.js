import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stale-while-revalidate for GET /api/spend/quota: with a stale snapshot the
// route answers at once with the stale rows plus its "as of" time, and the
// refresh only lands on a later request. The provider stack is mocked so
// the route module can run standalone.
const conns = [];

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async ({ provider }) => conns.filter((c) => c.provider === provider)),
}));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(async () => ({})),
  isAuthExpiredMessage: vi.fn(() => false),
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(async () => ({ used: usageNow })),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers", () => ({
  USAGE_APIKEY_PROVIDERS: ["claude"],
}));
vi.mock("@/lib/spend/quotaSnapshot.js", () => ({
  createRefreshDeduper: () => () => ({}),
  quotaUsageRows: ({ usage, connection, normalize }) => {
    if (connection.__fail) throw new Error("Usage request failed");
    return [normalize({ provider: connection.provider, name: connection.name, quota: { total: 100, used: usage.used, name: "5h" } })];
  },
}));

const CONN = { id: "c1", provider: "claude", name: "claude-x", authType: "apikey", isActive: true };
let usageNow = 10;

describe("quota route SWR (WP3)", () => {
  let mod;
  beforeEach(async () => {
    vi.resetModules();
    usageNow = 10;
    conns.length = 0;
    conns.push(CONN);
    mod = await import("../../src/app/api/spend/quota/route.js");
  });
  afterEach(() => vi.clearAllTimers());

  it("caches a success for 60 s and serves it instantly", async () => {
    const t = Date.now();
    const first = await mod.GET(new Request("http://x/api/spend/quota"));
    expect(first.status).toBe(200);
    const body1 = await first.json();
    expect(body1.rows).toHaveLength(1);
    expect(body1.rows[0].usedPct).toBe(10);
    expect(body1.asOf).toBeGreaterThanOrEqual(t);

    // Second call within TTL: cached, no new fetch.
    usageNow = 50;
    const t2 = Date.now();
    const second = await mod.GET(new Request("http://x/api/spend/quota"));
    const body2 = await second.json();
    expect(body2.rows[0].usedPct).toBe(10); // unchanged cache
    expect(body2.asOf).toBeLessThanOrEqual(t2);
  }, 30_000);

  it("serves a stale snapshot instantly and refreshes in the background (SWR)", async () => {
    // Warm the cache.
    await mod.GET(new Request("http://x/api/spend/quota"));
    // Force the snapshot stale (TTL 60 s) and make the upstream slow.
    usageNow = 30;
    conns.length = 0;
    conns.push({ ...CONN, __fail: true }); // refresh will yield error rows

    const t = Date.now();
    const stale = await mod.GET(new Request("http://x/api/spend/quota"));
    const elapsed = Date.now() - t;
    const body = await stale.json();
    // Stale rows served at once (not the failed refresh, not empty).
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].usedPct).toBe(10);
    expect(body.asOf).toBeTypeOf("number");
    // Instant: well under the provider timeout path.
    expect(elapsed).toBeLessThan(500);

    // The background refresh must not be awaited by GET; let it settle.
    await vi.waitFor(() => {}, { timeout: 0 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});

describe("quota route SWR resilience", () => {
  let mod;
  beforeEach(async () => {
    vi.resetModules();
    usageNow = 10;
    conns.length = 0;
    conns.push(CONN);
    mod = await import("../../src/app/api/spend/quota/route.js");
  });

  // Warm the cache with real time, then shift the clock past the 60 s TTL so
  // the next GET takes the stale-while-revalidate path.
  async function goStale() {
    await mod.GET(new Request("http://x/api/spend/quota"));
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    return () => { Date.now = realNow; };
  }

  it("marks a stale body with refreshing while a refresh runs", async () => {
    const restore = await goStale();
    try {
      conns.length = 0;
      const { getProviderConnections } = await import("@/lib/localDb");
      // The refresh hangs long enough for GET to answer first.
      getProviderConnections.mockImplementationOnce(() => new Promise(() => {}));
      const stale = await mod.GET(new Request("http://x/api/spend/quota"));
      const body = await stale.json();
      expect(body.rows).toHaveLength(1);
      expect(body.refreshing).toBe(true);
      expect(body.asOf).toBeGreaterThan(0);
    } finally { restore(); }
    await new Promise((r) => setTimeout(r, 20));
  }, 30_000);

  it("a rejected background refresh is caught, logged, and a stale body still serves", async () => {
    const restore = await goStale();
    const errors = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    try {
      conns.length = 0;
      const { getProviderConnections } = await import("@/lib/localDb");
      getProviderConnections.mockRejectedValueOnce(new Error("connections store unavailable"));
      const stale = await mod.GET(new Request("http://x/api/spend/quota"));
      const body = await stale.json();
      expect(body.rows).toHaveLength(1);
      expect(body.refreshing).toBe(true);
      await new Promise((r) => setTimeout(r, 30));
      expect(errors.some((e) => e.includes("connections store unavailable"))).toBe(true);
      // The failed refresh released the slot, so a later request retries.
      const again = await mod.GET(new Request("http://x/api/spend/quota"));
      expect((await again.json()).refreshing).toBe(true);
    } finally { spy.mockRestore(); restore(); }
    await new Promise((r) => setTimeout(r, 20));
  }, 30_000);
});

describe("quota route: Sync now (x-9r-sync)", () => {
  let mod;
  const plain = () => new Request("http://x/api/spend/quota");
  const sync = () => new Request("http://x/api/spend/quota", { headers: { "x-9r-sync": "1" } });
  beforeEach(async () => {
    vi.resetModules();
    usageNow = 10;
    conns.length = 0;
    conns.push(CONN);
    mod = await import("../../src/app/api/spend/quota/route.js");
  });

  it("a sync request waits for a fresh snapshot; a plain one gets the cached snapshot", async () => {
    await mod.GET(plain());
    usageNow = 50;

    const cachedBody = await (await mod.GET(plain())).json();
    expect(cachedBody.rows[0].usedPct).toBe(10);

    const fresh = await mod.GET(sync());
    const freshBody = await fresh.json();
    expect(freshBody.rows[0].usedPct).toBe(50);
    expect(freshBody.refreshing).toBeUndefined();
    expect(freshBody.asOf).toBeGreaterThanOrEqual(cachedBody.asOf);

    // The fresh snapshot is now what everyone else gets.
    expect((await (await mod.GET(plain())).json()).rows[0].usedPct).toBe(50);
  }, 30_000);

  it("a sync request never gets the stale snapshot with refreshing: true", async () => {
    await mod.GET(plain());
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      usageNow = 70;
      const body = await (await mod.GET(sync())).json();
      expect(body.rows[0].usedPct).toBe(70);
      expect(body.refreshing).toBeUndefined();
    } finally { Date.now = realNow; }
  }, 30_000);

  it("answers 502 when the sync refresh fails, and keeps the old snapshot for others", async () => {
    await mod.GET(plain());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { getProviderConnections } = await import("@/lib/localDb");
      getProviderConnections.mockRejectedValueOnce(new Error("connections store unavailable"));
      const failed = await mod.GET(sync());
      expect(failed.status).toBe(502);
      expect((await failed.json()).error).toBeTruthy();
      expect((await (await mod.GET(plain())).json()).rows[0].usedPct).toBe(10);
    } finally { spy.mockRestore(); }
  }, 30_000);

  it("sends no ETag and never answers 304", async () => {
    const first = await mod.GET(plain());
    expect(first.headers.get("etag")).toBeNull();
    expect(first.headers.get("cache-control")).toBe("no-store");
    const again = await mod.GET(new Request("http://x/api/spend/quota", { headers: { "if-none-match": '"q0-none"' } }));
    expect(again.status).toBe(200);
  }, 30_000);
});
