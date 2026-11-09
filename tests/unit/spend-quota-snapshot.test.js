import { describe, expect, it, vi } from "vitest";
import { createRefreshDeduper, quotaUsageRows } from "../../src/lib/spend/quotaSnapshot.js";
import { createSpendDrilldown } from "../../src/lib/spend/drilldown.js";

describe("quota snapshot helpers", () => {
  it("deduplicates forced refreshes while the original refresh remains pending", async () => {
    const dedupe = createRefreshDeduper();
    let resolve;
    const refresh = vi.fn(() => new Promise((r) => { resolve = r; }));
    const first = dedupe("c1", refresh);
    await Promise.resolve();
    const forced = dedupe("c1", refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolve({ connection: { id: "c1" } });
    expect(await first).toEqual({ connection: { id: "c1" } });
    expect(await forced).toEqual({ connection: { id: "c1" } });
  });

  it("turns empty quotas with an upstream message into a failure", () => {
    expect(() => quotaUsageRows({ usage: { message: "Quota endpoint unauthorized", quotas: {} }, connection: { provider: "antigravity" }, now: 0, normalize: vi.fn() })).toThrow("Quota endpoint unauthorized");
  });

  it("preserves estimated real spend through nodes and route links", () => {
    const normalize = ({ provider, name, quota }) => ({ provider, name, ...quota });
    const row = { provider: "deepseek", model: "m", cost: 2, real: 2, realEst: 2, tokens: {}, client: "cli", role: "main" };
    const a = createSpendDrilldown(); a.add(row);
    const out = a.result();
    expect(out.providerTree[0]).toMatchObject({ real: 2, realEst: 2 });
    expect(out.providerTree[0].models[0].efforts[0]).toMatchObject({ real: 2, realEst: 2 });
    expect(out.routes.links[0]).toMatchObject({ real: 2, realEst: 2 });
    expect(quotaUsageRows({ usage: { quotas: { x: { used: 1, total: 2 } } }, connection: { provider: "codex" }, now: 0, normalize })).toHaveLength(1);
  });
});
