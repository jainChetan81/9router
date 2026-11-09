import { describe, expect, it } from "vitest";
import { forecastQuota, normalizeQuotaRow, quotaRisk, windowLength } from "../../src/lib/spend/quotaRunway.js";
const H = 3600000;
describe("spend quota runway", () => {
  it("parses known windows and leaves unknown lengths null", () => {
    expect(windowLength("Rolling")).toBe(5 * H);
    expect(windowLength("weekly (7d)")).toBe(7 * 24 * H);
    expect(windowLength("Monthly")).toBeNull();
    expect(windowLength("Monthly", "opencode-go", Date.parse("2026-12-01T08:23:58Z"))).toBe(30 * 24 * H);
    expect(windowLength("Monthly", "opencode-go", Date.parse("2026-03-01T00:00:00Z"))).toBe(28 * 24 * H);
    expect(windowLength("Monthly", "opencode-go", Date.parse("2026-03-31T00:00:00Z"))).toBe(31 * 24 * H);
    expect(windowLength("session", "codex")).toBeNull();
    expect(windowLength("gemini-model-x")).toBeNull();
  });
  it("forecasts linearly and marks exhaustion before reset", () => {
    const now = 100000000;
    expect(forecastQuota({ usedPct: 50, resetAt: now + 3 * H, windowMs: 5 * H, now })).toEqual({ projectedPct: 125, runsOutAt: now + 2 * H });
    expect(forecastQuota({ usedPct: 20, resetAt: now + 4 * H, windowMs: 5 * H, now }).runsOutAt).toBeNull();
    expect(forecastQuota({ usedPct: 30, resetAt: now + 5 * H, windowMs: 5 * H, now })).toEqual({ projectedPct: null, runsOutAt: null });
    expect(forecastQuota({ usedPct: 30, resetAt: now - 1, windowMs: 5 * H, now })).toEqual({ projectedPct: null, runsOutAt: null });
    expect(forecastQuota({ usedPct: 30, resetAt: now + 6 * H, windowMs: 5 * H, now })).toEqual({ projectedPct: null, runsOutAt: null });
    expect(forecastQuota({ usedPct: 0, resetAt: now + 3 * H, windowMs: 5 * H, now })).toEqual({ projectedPct: 0, runsOutAt: null });
  });
  it("classifies risk and preserves unlimited Muse counts", () => {
    expect(quotaRisk(null, null)).toBe("unknown");
    expect(quotaRisk(90, null)).toBe("high");
    expect(quotaRisk(70, null)).toBe("warn");
    expect(quotaRisk(20, 85)).toBe("warn");
    expect(quotaRisk(20, 100)).toBe("high");
    expect(normalizeQuotaRow({ provider: "muse", name: "Muse", quota: { used: 9, total: 0, unlimited: true, name: "Last 5h tokens" }, now: 100 }).used).toBe(9);
    expect(normalizeQuotaRow({ provider: "muse", name: "Muse", quota: { used: 9, total: 0, unlimited: true, name: "Last 5h tokens" }, now: 100 })).toMatchObject({ limitKnown: false, usedPct: null, risk: "unknown" });
  });
});
