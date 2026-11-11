import { describe, expect, it } from "vitest";
import { estimateMove } from "../../src/lib/spend/whatIf.js";

describe("what-if estimate", () => {
  it("uses each recorded token class and reports delta against recorded cost", () => {
    const result = estimateMove({ input: 1_000_000, cacheRead: 200_000, cacheWrite: 100_000, output: 50_000, cost: 2 }, { input: 1, cached: 0.5, cache_creation: 2, output: 4 });
    expect(result.cost).toBeCloseTo(1.5);
    expect(result.delta).toBeCloseTo(-0.5);
  });
});
