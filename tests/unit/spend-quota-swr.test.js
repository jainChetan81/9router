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
