import { describe, expect, it } from "vitest";
import { createSpendDrilldown, splitTokens } from "../../src/lib/spend/drilldown.js";

describe("spend drilldown", () => {
  it("splits uncached, cache and output tokens with aliases and missing values", () => {
    expect(splitTokens('{"prompt_tokens":100,"cached_tokens":60,"cache_creation_input_tokens":15,"completion_tokens":8}')).toEqual({ input: 25, cacheRead: 60, cacheWrite: 15, output: 8 });
    expect(splitTokens({ input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 25 })).toEqual({ input: 0, cacheRead: 25, cacheWrite: 0, output: 4 });
    expect(splitTokens(null, 6, 2)).toEqual({ input: 6, cacheRead: 0, cacheWrite: 0, output: 2 });
    expect(splitTokens("bad", 3, 1)).toEqual({ input: 3, cacheRead: 0, cacheWrite: 0, output: 1 });
  });
  it("sorts tree nodes, defaults effort and only adds logged rows to routes", () => {
    const a = createSpendDrilldown();
    a.add({ provider: "deepseek", model: "z", cost: 1, real: 0.5, tokens: { prompt_tokens: 4 }, client: "cli", role: "main" });
    a.add({ provider: "openrouter", model: "a", cost: 3, real: 2, tokens: {}, client: null });
    a.add({ provider: "deepseek", model: "a", cost: 5, real: 4, tokens: {}, client: "web", role: "alt", effort: "high" });
    const out = a.result();
    expect(out.providerTree.map((x) => x.k)).toEqual(["deepseek", "openrouter"]);
    expect(out.providerTree[0].models[0].efforts[0].k).toBe("high");
    expect(out.providerTree[0].models[1].efforts[0].k).toBe("Unknown");
    expect(out.routes.links.every((x) => x.paid)).toBe(true);
    expect(out.routes.links.reduce((n, x) => n + x.req, 0)).toBe(4);
    expect(out.routes.nodes.some((x) => x.kind === "combo")).toBe(true);
    expect(out.routes.nodes.some((x) => x.id === "provider:openrouter")).toBe(false);
  });
});
