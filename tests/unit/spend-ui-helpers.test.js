import { describe, expect, it } from "vitest";
import { mapQuotaRows, mapRoutes, quotaTotal, sankeyLayout, sortQuotaRunway, topPaidRoute, windowLabel } from "../../src/lib/spend/uiHelpers.js";

const NOW = Date.UTC(2026, 10, 9, 12);

describe("quota runway mapping", () => {
  it("merges Muse request and token rows into one usage row per span", () => {
    const rows = mapQuotaRows([
      { provider: "muse", name: "m", window: "Last 5h requests", used: 80, usedPct: null, windowMs: 18e6, risk: "unknown", limitKnown: false },
      { provider: "muse", name: "m", window: "Last 5h tokens", used: 3_200_000, usedPct: null, windowMs: 18e6, risk: "unknown", limitKnown: false },
      { provider: "muse", name: "m", window: "Last 7d requests", used: 1904, usedPct: null, risk: "unknown", limitKnown: false },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ prov: "Muse", win: "Last 5 h", usage: "80 req · 3.2M tok", usageOnly: true, risk: "unknown" });
    expect(rows[1].win).toBe("Last 7 d");
  });

  it("collapses Antigravity per-model rows and keeps windowed rows separate", () => {
    const ag = (window, used, windowMs = null) => ({ provider: "antigravity", name: "acct", window, used, usedPct: used / 10, windowMs, resetAt: NOW + 1e6, risk: "ok", limitKnown: true });
    const rows = mapQuotaRows([ag("gemini_weekly (Gemini (Weekly))", 548, 6048e5), ag("model-a (Model A)", 112), ag("model-b (Model B)", 300), ag("model-c (Model C)", 0)]);
    expect(rows).toHaveLength(2);
    const weekly = rows.find((r) => r.win === "Gemini (Weekly)");
    expect(weekly.known).toBe(true);
    const models = rows.find((r) => r.more);
    expect(models.win).toBe("Model B");
    expect(models.used).toBe("300 / 1,000");
    expect(models.more.map((m) => m.win)).toEqual(["Model A", "Model C"]);
    expect(quotaTotal(rows)).toBe(4);
  });

  it("sorts by risk, then used percent, with errors last", () => {
    const rows = sortQuotaRunway([
      { id: "u", risk: "unknown", pct: 99 }, { id: "e", risk: "error" }, { id: "ok", risk: "ok", pct: 20 },
      { id: "ok2", risk: "ok", pct: 50 }, { id: "h", risk: "high", pct: 10 }, { id: "w", risk: "warn", pct: 72 },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["h", "w", "ok2", "ok", "u", "e"]);
  });

  it("maps error rows and keeps plain window names", () => {
    const rows = mapQuotaRows([{ provider: "codex", name: "c", error: "usage request timed out" }, { provider: "claude", name: "x", window: "weekly (7d)", usedPct: 50, windowMs: 6048e5, risk: "ok", limitKnown: true }]);
    expect(rows[0]).toMatchObject({ risk: "error", err: "OpenAI Codex: usage request timed out" });
    expect(rows[1].win).toBe("weekly (7d)");
    expect(windowLabel("gemini-3.8-flash-high (Gemini 3.8 Flash (High))")).toBe("Gemini 3.8 Flash (High)");
  });
});

describe("routing map", () => {
  const routes = {
    links: [
      { source: "combo:main", target: "provider:claude", req: 90, v: 10, real: 0, realEst: 0, paid: false },
      { source: "combo:reviewer", target: "provider:claude", req: 10, v: 1, real: 0, realEst: 0, paid: false },
      { source: "combo:reviewer", target: "provider:openrouter", req: 5, v: 2, real: 2, realEst: 0.5, paid: true },
      { source: "provider:claude", target: "model:claude:claude-opus-5-5", req: 70, v: 9, real: 0, realEst: 0, paid: false },
      { source: "provider:claude", target: "model:claude:claude-haiku-5-5", req: 30, v: 2, real: 0, realEst: 0, paid: false },
      { source: "provider:openrouter", target: "model:openrouter:a/b", req: 5, v: 2, real: 2, realEst: 0.5, paid: true },
    ],
  };

  it("splits edges into combo->provider and provider->model links", () => {
    const { l1, l2 } = mapRoutes(routes);
    expect(l1.map((l) => `${l.combo}>${l.prov}`)).toEqual(["main>Claude Code", "reviewer>Claude Code", "reviewer>OpenRouter"]);
    expect(l2.find((l) => l.model === "a/b")).toMatchObject({ prov: "OpenRouter", paid: true, real: 2, est: 0.5 });
  });

  it("stacks bands so each provider's in-flow equals its out-flow, with main first", () => {
    const lay = sankeyLayout(mapRoutes(routes), (l) => l.req, 1000);
    expect(lay.combos[0].key).toBe("main");
    const claude = lay.provs.find((p) => p.key === "Claude Code");
    const inW = lay.bands.filter((b) => b.combo && b.prov === "Claude Code").reduce((s, b) => s + b.w, 0);
    const outW = lay.bands.filter((b) => b.mk && b.prov === "Claude Code").reduce((s, b) => s + b.w, 0);
    expect(inW).toBeCloseTo(claude.h, 6);
    expect(outW).toBeCloseTo(claude.h, 6);
    // Paid providers sort after subscriptions.
    expect(lay.provs.map((p) => p.key)).toEqual(["Claude Code", "OpenRouter"]);
  });

  it("gives every node a minimum slot and keeps model labels apart", () => {
    const lay = sankeyLayout(mapRoutes(routes), (l) => l.req, 1000);
    const ys = lay.models.map((m) => m.ly);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(13);
    expect(lay.H).toBeGreaterThanOrEqual(380);
  });

  it("names the combo with the most real spend on a paid provider", () => {
    expect(topPaidRoute(mapRoutes(routes).l1)).toMatchObject({ combo: "reviewer", prov: "OpenRouter", req: 5, real: 2 });
    expect(topPaidRoute([])).toBeNull();
  });
});
