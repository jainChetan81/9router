import { describe, expect, it } from "vitest";
import { addModelEffortUsage } from "../../src/lib/spend/modelEffortGroups.js";

describe("Spend model + effort grouping", () => {
  it("groups requests, tokens and cost by model and sent effort", () => {
    const groups = new Map();
    addModelEffortUsage(groups, { model: "gpt-6-luna", effort: "high", cost: 0.1, real: 0, tokens: 100 });
    addModelEffortUsage(groups, { model: "gpt-6-luna", effort: "high", cost: 0.2, real: 0, tokens: 200 });
    addModelEffortUsage(groups, { model: "gpt-6-luna", effort: null, cost: 0.3, real: 0, tokens: 300 });

    const [high, unknown] = [...groups.values()];
    expect(high).toMatchObject({ k: "gpt-6-luna · high", model: "gpt-6-luna", effort: "high", real: 0, req: 2, tok: 300 });
    expect(high.v).toBeCloseTo(0.3);
    expect(unknown).toMatchObject({ k: "gpt-6-luna · Unknown", model: "gpt-6-luna", effort: "Unknown", v: 0.3, real: 0, req: 1, tok: 300 });
  });
});
