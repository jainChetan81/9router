import { describe, it, expect } from "vitest";
import { sanitizeDashboardSync, syncSecondsFor, syncLabel, SYNC_DEFAULTS } from "../../src/lib/dashboardSync.js";

describe("dashboardSync", () => {
  it("keeps known pages with allowed values", () => {
    expect(sanitizeDashboardSync({ agents: 30, spend: "0" })).toEqual({ agents: 30, spend: 0 });
  });
  it("rejects bad values, bad shapes and empty input", () => {
    expect(sanitizeDashboardSync({ agents: 7 })).toBeNull();
    expect(sanitizeDashboardSync({ agents: -1 })).toBeNull();
    expect(sanitizeDashboardSync([10])).toBeNull();
    expect(sanitizeDashboardSync("x")).toBeNull();
    expect(sanitizeDashboardSync({ other: 10 })).toBeNull();
  });
  it("drops unknown pages", () => {
    expect(sanitizeDashboardSync({ agents: 10, __proto__x: 10 })).toEqual({ agents: 10 });
  });
  it("falls back to defaults", () => {
    expect(syncSecondsFor({}, "agents")).toBe(SYNC_DEFAULTS.agents);
    expect(syncSecondsFor({ dashboardSync: { agents: 60 } }, "agents")).toBe(60);
    expect(syncSecondsFor({ dashboardSync: { agents: 7 } }, "agents")).toBe(SYNC_DEFAULTS.agents);
  });
  it("labels intervals", () => {
    expect(syncLabel(0)).toBe("Off");
    expect(syncLabel(30)).toBe("30 s");
    expect(syncLabel(300)).toBe("5 min");
  });
});
